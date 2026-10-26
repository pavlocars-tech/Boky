import { createPublicKey, type KeyObject } from "node:crypto";
import type { DeviceConfig, GpsPoint, Heartbeat, PairingStart, PlaybackEvent } from "@taxiads/shared";
import { decodeJwt, jwtVerify } from "jose";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { audit } from "../lib/audit";
import { issueDeviceToken, type DeviceAuth } from "../lib/auth";
import { pairingCode } from "../lib/crypto";
import { AppError, badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { ensurePartitions } from "../lib/partitions";
import { loadSettings, stableHash } from "../lib/settings";
import { latestPlaylistVersion, requestPlaylistRebuild } from "./playlists";

const PAIRING_TTL_MS = 30 * 60_000;
export const DEVICE_ASSERTION_AUDIENCE = "taxiads-device-auth";

/** Prüft, ob der Schlüssel ein EC-P-256-Schlüssel (SPKI/DER, Base64) ist. */
export function parseDevicePublicKey(base64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
  } catch {
    throw badRequest("invalid_public_key", "Öffentlicher Schlüssel ungültig.");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw badRequest("invalid_public_key", "Erwartet wird ein EC-P-256-Schlüssel.");
  }
  return key;
}

interface PairingRow {
  id: string;
  code: string;
  status: "pending" | "claimed" | "expired";
  expires_at: Date;
  device_id: string | null;
}

function serializePairing(p: PairingRow) {
  return {
    pairingId: p.id,
    code: p.code,
    status: p.status,
    expiresAt: p.expires_at.toISOString(),
    deviceId: p.device_id,
  };
}

/** Schritt 1: Gerät meldet sich mit seinem öffentlichen Schlüssel und erhält einen Kopplungscode. */
export async function startPairing(ctx: AppContext, input: PairingStart) {
  parseDevicePublicKey(input.publicKey);
  const [existing] = await ctx.sql<{ id: string; status: string }[]>`
    SELECT id, status FROM devices WHERE public_key = ${input.publicKey}
  `;
  if (existing) {
    // Schlüssel ist schon gekoppelt (z. B. Antwort ging verloren) – Gerät kann sich direkt anmelden.
    if (existing.status !== "active") throw new AppError(403, "device_blocked", "Gerät ist gesperrt.");
    return { pairingId: null, code: null, status: "claimed" as const, expiresAt: null, deviceId: existing.id };
  }
  await ctx.sql`
    UPDATE device_pairings SET status = 'expired'
    WHERE status = 'pending' AND (expires_at < ${ctx.now()} OR public_key = ${input.publicKey})
  `;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const [p] = await ctx.sql<PairingRow[]>`
        INSERT INTO device_pairings (code, public_key, device_info, expires_at)
        VALUES (${pairingCode()}, ${input.publicKey}, ${ctx.sql.json(input.deviceInfo as never)},
                ${new Date(ctx.now().getTime() + PAIRING_TTL_MS)})
        RETURNING id, code, status, expires_at, device_id
      `;
      return serializePairing(p!);
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err; // Code zufällig doppelt -> neu würfeln
    }
  }
  throw new Error("Kein freier Kopplungscode gefunden");
}

/** Schritt 2 (Gerät fragt ab): Wurde der Code im Admin-Bereich eingegeben? */
export async function getPairing(ctx: AppContext, pairingId: string) {
  const [p] = await ctx.sql<PairingRow[]>`
    UPDATE device_pairings SET status = CASE WHEN status = 'pending' AND expires_at < ${ctx.now()} THEN 'expired' ELSE status END
    WHERE id = ${pairingId}
    RETURNING id, code, status, expires_at, device_id
  `;
  if (!p) throw notFound("Kopplung nicht gefunden.");
  return serializePairing(p);
}

/** Schritt 3 (Admin): Code eingeben und Gerät einem Fahrzeug zuordnen. */
export async function claimPairing(
  ctx: AppContext,
  adminId: string,
  input: { code: string; vehicleId: string; screenSlot?: number; name?: string; replace?: boolean },
) {
  const settings = await loadSettings(ctx.sql);
  const deviceId = await ctx.sql.begin(async (tx) => {
    const [p] = await tx<(PairingRow & { public_key: string; device_info: Record<string, string> })[]>`
      SELECT * FROM device_pairings
      WHERE code = ${input.code} AND status = 'pending' AND expires_at > ${ctx.now()}
      FOR UPDATE
    `;
    if (!p) throw notFound("Code unbekannt oder abgelaufen.");
    const [device] = await tx<{ id: string }[]>`
      INSERT INTO devices (public_key, name, manufacturer, model, android_version, app_version, serial)
      VALUES (${p.public_key}, ${input.name ?? null}, ${p.device_info.manufacturer ?? null}, ${p.device_info.model ?? null},
              ${p.device_info.androidVersion ?? null}, ${p.device_info.appVersion ?? null}, ${p.device_info.serial ?? null})
      RETURNING id
    `;
    await assignInTx(
      tx,
      device!.id,
      input.vehicleId,
      input.screenSlot ?? null,
      settings.maxScreensPerVehicle,
      input.replace ?? false,
    );
    await tx`
      UPDATE device_pairings SET status = 'claimed', device_id = ${device!.id}, claimed_at = now(), claimed_by = ${adminId}
      WHERE id = ${p.id}
    `;
    await audit(tx, adminId, "device.pair", "device", device!.id, { vehicleId: input.vehicleId });
    return device!.id;
  });
  return deviceId;
}

/**
 * Gerät einem Fahrzeug (oder keinem) zuordnen. Pro Fahrzeug höchstens
 * `maxScreens` Bildschirme; Platz 1..maxScreens. Mit `replace` wird ein Gerät
 * auf dem gewünschten Platz abgemeldet (Tausch eines defekten Tablets).
 */
async function assignInTx(
  tx: Db,
  deviceId: string,
  vehicleId: string | null,
  slot: number | null,
  maxScreens: number,
  replace: boolean,
) {
  const [current] = await tx<{ vehicle_id: string | null; screen_slot: number | null }[]>`
    SELECT vehicle_id, screen_slot FROM devices WHERE id = ${deviceId} FOR UPDATE
  `;
  if (!current) throw notFound("Gerät nicht gefunden.");
  let targetSlot: number | null = null;
  if (vehicleId) {
    const [vehicle] = await tx`SELECT id FROM vehicles WHERE id = ${vehicleId} FOR UPDATE`;
    if (!vehicle) throw notFound("Fahrzeug nicht gefunden.");
    const others = await tx<{ id: string; screen_slot: number }[]>`
      SELECT id, screen_slot FROM devices WHERE vehicle_id = ${vehicleId} AND id <> ${deviceId}
    `;
    const taken = new Set(others.map((o) => o.screen_slot));
    if (slot !== null) {
      if (slot < 1 || slot > maxScreens)
        throw badRequest("invalid_slot", `Bildschirmplatz muss zwischen 1 und ${maxScreens} liegen.`);
      if (taken.has(slot)) {
        if (!replace) throw conflict("slot_taken", `Platz ${slot} ist bereits belegt.`);
        const old = others.find((o) => o.screen_slot === slot)!;
        await tx`UPDATE devices SET vehicle_id = NULL, screen_slot = NULL WHERE id = ${old.id}`;
        await tx`UPDATE device_assignments SET unassigned_at = now() WHERE device_id = ${old.id} AND unassigned_at IS NULL`;
      }
      targetSlot = slot;
    } else {
      for (let s = 1; s <= maxScreens; s++) {
        if (!taken.has(s)) {
          targetSlot = s;
          break;
        }
      }
      if (targetSlot === null) throw conflict("vehicle_full", `Fahrzeug hat bereits ${maxScreens} Bildschirme.`);
    }
  }
  if (current.vehicle_id !== vehicleId || current.screen_slot !== targetSlot) {
    await tx`UPDATE devices SET vehicle_id = ${vehicleId}, screen_slot = ${targetSlot} WHERE id = ${deviceId}`;
    if (current.vehicle_id !== vehicleId) {
      await tx`UPDATE device_assignments SET unassigned_at = now() WHERE device_id = ${deviceId} AND unassigned_at IS NULL`;
      if (vehicleId) await tx`INSERT INTO device_assignments (device_id, vehicle_id) VALUES (${deviceId}, ${vehicleId})`;
    }
  }
  if (vehicleId) await requestPlaylistRebuild(tx, [vehicleId]);
}

export async function assignDevice(
  ctx: AppContext,
  adminId: string,
  deviceId: string,
  input: { vehicleId: string | null; screenSlot?: number | null; replace?: boolean },
) {
  const settings = await loadSettings(ctx.sql);
  await ctx.sql.begin(async (tx) => {
    await assignInTx(
      tx,
      deviceId,
      input.vehicleId,
      input.screenSlot ?? null,
      settings.maxScreensPerVehicle,
      input.replace ?? false,
    );
    await audit(tx, adminId, "device.assign", "device", deviceId, { ...input });
  });
}

/** Geräte-Anmeldung: vom Gerät signiertes JWT gegen kurzlebiges Zugriffstoken tauschen. */
export async function exchangeDeviceAssertion(ctx: AppContext, assertion: string) {
  let deviceId: string | undefined;
  try {
    deviceId = decodeJwt(assertion).sub;
  } catch {
    throw unauthorized("Anmeldung ungültig.");
  }
  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) throw unauthorized("Anmeldung ungültig.");
  const [device] = await ctx.sql<{ id: string; public_key: string; status: string }[]>`
    SELECT id, public_key, status FROM devices WHERE id = ${deviceId}
  `;
  if (!device) throw unauthorized("Gerät unbekannt.");
  if (device.status !== "active") throw new AppError(403, "device_blocked", "Gerät ist gesperrt.");
  try {
    await jwtVerify(assertion, parseDevicePublicKey(device.public_key), {
      algorithms: ["ES256"],
      audience: DEVICE_ASSERTION_AUDIENCE,
      subject: device.id,
      currentDate: ctx.now(),
      maxTokenAge: "10m",
      clockTolerance: "10m",
    });
  } catch (err) {
    // Serverzeit mitschicken, damit ein Gerät mit falscher Uhr sich korrigieren kann.
    throw new AppError(401, "invalid_assertion", "Signatur ungültig oder Uhrzeit des Geräts falsch.", {
      serverTime: ctx.now().toISOString(),
      reason: (err as Error).message,
    });
  }
  const { token, expiresIn } = await issueDeviceToken(ctx, device.id);
  return { accessToken: token, expiresIn, serverTime: ctx.now().toISOString() };
}

export async function deviceConfig(ctx: AppContext, device: DeviceAuth): Promise<DeviceConfig> {
  const settings = await loadSettings(ctx.sql);
  const [vehicle] = device.vehicleId
    ? await ctx.sql<{ label: string }[]>`SELECT label FROM vehicles WHERE id = ${device.vehicleId}`
    : [];
  const config = {
    deviceId: device.id,
    vehicleId: device.vehicleId,
    vehicleLabel: vehicle?.label ?? null,
    screenSlot: device.screenSlot,
    timezone: settings.timezone,
    gpsIntervalSeconds: settings.gpsIntervalSeconds,
    heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
    uploadIntervalSeconds: settings.uploadIntervalSeconds,
    brightnessSchedule: settings.brightnessSchedule,
  };
  return { hash: stableHash(config), ...config };
}

export async function recordHeartbeat(ctx: AppContext, device: DeviceAuth, hb: Heartbeat, ip: string) {
  const now = ctx.now();
  const skew = new Date(hb.sentAt).getTime() - now.getTime();
  await ctx.sql`
    UPDATE devices SET
      last_seen_at = ${now}, last_ip = ${ip}, last_playlist_version = ${hb.playlistVersion},
      last_config_hash = ${hb.configHash}, last_free_storage_bytes = ${hb.freeStorageBytes},
      last_total_storage_bytes = ${hb.totalStorageBytes}, app_version = ${hb.appVersion},
      last_battery_percent = ${hb.batteryPercent ?? null}, last_brightness_percent = ${hb.brightnessPercent ?? null},
      last_clock_skew_ms = ${Math.max(-2_000_000_000, Math.min(2_000_000_000, skew))},
      last_now_playing = ${hb.nowPlaying ? ctx.sql.json(hb.nowPlaying as never) : null},
      last_pending = ${hb.pending ? ctx.sql.json(hb.pending as never) : null}
    WHERE id = ${device.id}
  `;
  await ensurePartitions(ctx.sql, "device_heartbeats", [now]);
  await ctx.sql`INSERT INTO device_heartbeats (device_id, received_at, payload) VALUES (${device.id}, ${now}, ${ctx.sql.json(hb as never)})`;
  const config = await deviceConfig(ctx, device);
  return {
    serverTime: now.toISOString(),
    playlistVersion: device.vehicleId ? await latestPlaylistVersion(ctx.sql, device.vehicleId) : null,
    configHash: config.hash,
  };
}

/** Fahrzeuge, denen das Gerät jemals zugeordnet war (Logs können verspätet eintreffen). */
async function deviceVehicles(db: Db, deviceId: string): Promise<Set<string>> {
  const rows = await db<
    { vehicle_id: string }[]
  >`SELECT DISTINCT vehicle_id FROM device_assignments WHERE device_id = ${deviceId}`;
  return new Set(rows.map((r) => r.vehicle_id));
}

/** Zeitstempel außerhalb dieses Fensters gelten als kaputte Geräteuhr und werden verworfen. */
function plausible(instant: Date, now: Date): boolean {
  const t = instant.getTime();
  return t > now.getTime() - 400 * 86_400_000 && t < now.getTime() + 2 * 86_400_000;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

export async function ingestPlaybackEvents(ctx: AppContext, device: DeviceAuth, events: PlaybackEvent[]): Promise<IngestResult> {
  const now = ctx.now();
  const vehicles = await deviceVehicles(ctx.sql, device.id);
  const valid = events.filter((e) => vehicles.has(e.vehicleId) && plausible(new Date(e.startedAt), now));
  const rejected = events.length - valid.length;
  if (valid.length === 0) return { accepted: 0, duplicates: 0, rejected };
  await ensurePartitions(
    ctx.sql,
    "playback_events",
    valid.map((e) => new Date(e.startedAt)),
  );
  const rows = valid.map((e) => ({
    id: e.id,
    vehicle_id: e.vehicleId,
    kind: e.kind,
    campaign_id: e.campaignId ?? null,
    creative_id: e.creativeId ?? null,
    filler_id: e.fillerId ?? null,
    media_asset_id: e.mediaId ?? null,
    started_at: e.startedAt,
    planned_ms: e.plannedMs,
    played_ms: e.playedMs,
    completed: e.completed,
    abort_reason: e.abortReason ?? null,
    lat: e.position?.lat ?? null,
    lon: e.position?.lon ?? null,
    accuracy: e.position?.accuracy ?? null,
    playlist_version: e.playlistVersion,
  }));
  const inserted = await ctx.sql`
    INSERT INTO playback_events (id, device_id, vehicle_id, kind, campaign_id, creative_id, filler_id, media_asset_id,
      started_at, planned_ms, played_ms, completed, abort_reason, position, position_accuracy, playlist_version)
    SELECT x.id, ${device.id}, x.vehicle_id, x.kind, x.campaign_id, x.creative_id, x.filler_id, x.media_asset_id,
      x.started_at, x.planned_ms, x.played_ms, x.completed, x.abort_reason,
      CASE WHEN x.lat IS NULL OR x.lon IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326)::geography END,
      x.accuracy, x.playlist_version
    FROM jsonb_to_recordset(${ctx.sql.json(rows as never)}) AS x(
      id uuid, vehicle_id uuid, kind text, campaign_id uuid, creative_id uuid, filler_id uuid, media_asset_id uuid,
      started_at timestamptz, planned_ms int, played_ms int, completed boolean, abort_reason text,
      lat double precision, lon double precision, accuracy real, playlist_version int)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return { accepted: inserted.length, duplicates: valid.length - inserted.length, rejected };
}

export async function ingestGpsPoints(ctx: AppContext, device: DeviceAuth, points: GpsPoint[]): Promise<IngestResult> {
  const now = ctx.now();
  if (!device.vehicleId) return { accepted: 0, duplicates: 0, rejected: points.length };
  const valid = points.filter((p) => plausible(new Date(p.recordedAt), now));
  const rejected = points.length - valid.length;
  if (valid.length === 0) return { accepted: 0, duplicates: 0, rejected };
  await ensurePartitions(
    ctx.sql,
    "gps_points",
    valid.map((p) => new Date(p.recordedAt)),
  );
  const rows = valid.map((p) => ({
    id: p.id,
    recorded_at: p.recordedAt,
    lat: p.lat,
    lon: p.lon,
    accuracy: p.accuracy ?? null,
    speed: p.speed ?? null,
    heading: p.heading ?? null,
  }));
  const inserted = await ctx.sql`
    INSERT INTO gps_points (id, device_id, vehicle_id, recorded_at, position, accuracy, speed, heading)
    SELECT x.id, ${device.id}, ${device.vehicleId}, x.recorded_at,
      ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326)::geography, x.accuracy, x.speed, x.heading
    FROM jsonb_to_recordset(${ctx.sql.json(rows as never)}) AS x(
      id uuid, recorded_at timestamptz, lat double precision, lon double precision, accuracy real, speed real, heading real)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  const newest = valid.reduce((a, b) => (a.recordedAt > b.recordedAt ? a : b));
  await ctx.sql`
    UPDATE devices SET last_position = ST_SetSRID(ST_MakePoint(${newest.lon}, ${newest.lat}), 4326)::geography,
      last_position_at = ${newest.recordedAt}
    WHERE id = ${device.id} AND (last_position_at IS NULL OR last_position_at < ${newest.recordedAt})
  `;
  return { accepted: inserted.length, duplicates: valid.length - inserted.length, rejected };
}

/** Darf das Gerät diese Mediendatei laden? Nur Dateien aus den letzten Playlists seines Fahrzeugs. */
export async function mediaKeyForDevice(db: Db, device: DeviceAuth, mediaId: string): Promise<string> {
  if (!device.vehicleId) throw notFound();
  const [row] = await db<{ processed_key: string }[]>`
    SELECT m.processed_key FROM media_assets m
    WHERE m.id = ${mediaId} AND m.status = 'ready'
      AND EXISTS (
        SELECT 1 FROM (
          SELECT body FROM playlists WHERE vehicle_id = ${device.vehicleId} ORDER BY version DESC LIMIT 3
        ) p WHERE p.body->'media' @> ${db.json([{ id: mediaId }] as never)}
      )
  `;
  if (!row) throw notFound("Datei nicht gefunden.");
  return row.processed_key;
}
