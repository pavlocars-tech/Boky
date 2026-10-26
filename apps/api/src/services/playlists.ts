import {
  addDays,
  buildLoop,
  eachDay,
  localDate,
  type CreativeInput,
  type FillerInput,
  type IsoDate,
  type Playlist,
  type PlaylistMedia,
  type SpotInput,
} from "@taxiads/shared";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { enqueue } from "../lib/jobs";
import { loadSettings, stableHash } from "../lib/settings";

/** Neuaufbau der Playlists anfordern (wird vom Worker abgearbeitet). */
export async function requestPlaylistRebuild(db: Db, vehicleIds: string[] | "all"): Promise<void> {
  if (vehicleIds === "all") {
    await enqueue(db, "playlist.build_all", {}, { dedupeKey: "playlist:all" });
    return;
  }
  for (const vehicleId of new Set(vehicleIds)) {
    await enqueue(db, "playlist.build", { vehicleId }, { dedupeKey: `playlist:${vehicleId}` });
  }
}

export async function enqueueAllPlaylists(db: Db): Promise<number> {
  const vehicles = await db<{ id: string }[]>`SELECT id FROM vehicles`;
  await requestPlaylistRebuild(
    db,
    vehicles.map((v) => v.id),
  );
  return vehicles.length;
}

interface AllocationRow {
  campaign_id: string;
  start_date: IsoDate;
  end_date: IsoDate;
  seconds_per_loop: number;
  status: "booked" | "paused";
  booked_at: Date | null;
}

interface MediaRow {
  media_id: string;
  media_type: "image" | "video";
  duration_ms: number | null;
  sha256: string;
  size_bytes: string | number;
  width: number | null;
  height: number | null;
}

/** Toleranz für Videolängen (Container-Rundung), muss zur Upload-Prüfung passen. */
export const VIDEO_TOLERANCE_MS = 500;

export function creativeFits(durationMs: number | null, seconds: number): boolean {
  return durationMs === null || durationMs <= seconds * 1000 + VIDEO_TOLERANCE_MS;
}

/** Baut die Playlist eines Fahrzeugs für die nächsten Tage (ohne Speichern). */
export async function composePlaylist(
  db: Db,
  vehicleId: string,
  now: Date,
): Promise<Omit<Playlist, "version" | "generatedAt"> & { hash: string }> {
  const settings = await loadSettings(db);
  const first = localDate(now, settings.timezone);
  const last = addDays(first, settings.playlistDaysAhead - 1);

  const allocations = await db<AllocationRow[]>`
    SELECT a.campaign_id, a.start_date, a.end_date, a.seconds_per_loop, c.status, c.booked_at
    FROM allocations a
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.vehicle_id = ${vehicleId}
      AND a.period && daterange(${first}::date, ${last}::date, '[]')
      AND c.status IN ('booked', 'paused')
    ORDER BY c.booked_at NULLS LAST, c.id
  `;
  const campaignIds = [...new Set(allocations.map((a) => a.campaign_id))];
  const creatives = campaignIds.length
    ? await db<(MediaRow & { creative_id: string; campaign_id: string })[]>`
        SELECT cr.id AS creative_id, cr.campaign_id, m.id AS media_id, m.media_type, m.duration_ms,
               m.sha256, m.size_bytes, m.width, m.height
        FROM creatives cr
        JOIN media_assets m ON m.id = cr.media_asset_id
        WHERE cr.campaign_id = ANY(${campaignIds}::uuid[]) AND cr.status = 'approved' AND m.status = 'ready'
        ORDER BY cr.sort_order, cr.created_at, cr.id
      `
    : [];
  const fillers = await db<(MediaRow & { filler_id: string; start_date: IsoDate | null; end_date: IsoDate | null })[]>`
    SELECT f.id AS filler_id, f.start_date, f.end_date, m.id AS media_id, m.media_type, m.duration_ms,
           m.sha256, m.size_bytes, m.width, m.height
    FROM fillers f
    JOIN media_assets m ON m.id = f.media_asset_id
    WHERE f.active AND m.status = 'ready'
      AND (f.end_date IS NULL OR f.end_date >= ${first}::date)
      AND (f.start_date IS NULL OR f.start_date <= ${last}::date)
    ORDER BY f.sort_order, f.created_at, f.id
  `;

  const mediaById = new Map<string, MediaRow>();
  for (const m of [...creatives, ...fillers]) mediaById.set(m.media_id, m);

  const days = eachDay(first, last).map((date) => {
    const today = allocations.filter((a) => a.start_date <= date && a.end_date >= date);
    const spots: SpotInput[] = today
      .filter((a) => a.status === "booked")
      .map((a) => ({
        campaignId: a.campaign_id,
        seconds: a.seconds_per_loop,
        creatives: creatives
          .filter((c) => c.campaign_id === a.campaign_id && creativeFits(c.duration_ms, a.seconds_per_loop))
          .map((c): CreativeInput => ({
            creativeId: c.creative_id,
            mediaId: c.media_id,
            mediaType: c.media_type,
            durationMs: c.duration_ms,
          })),
      }));
    const inactiveSeconds = today.filter((a) => a.status === "paused").reduce((s, a) => s + a.seconds_per_loop, 0);
    const dayFillers: FillerInput[] = fillers
      .filter((f) => (!f.start_date || f.start_date <= date) && (!f.end_date || f.end_date >= date))
      .map((f) => ({ fillerId: f.filler_id, mediaId: f.media_id, mediaType: f.media_type, durationMs: f.duration_ms }));
    const plan = buildLoop({
      loopSeconds: settings.loopSeconds,
      spots,
      inactiveSeconds,
      fillers: dayFillers,
      options: { fillerImageMs: settings.fillerImageSeconds * 1000 },
    });
    return { date, loopMs: plan.loopMs, slots: plan.slots };
  });

  const used = new Set<string>();
  for (const d of days)
    for (const s of d.slots) for (const v of s.variants) for (const p of v) if (p.mediaId) used.add(p.mediaId);
  const media: PlaylistMedia[] = [...used].sort().map((id) => {
    const m = mediaById.get(id)!;
    return {
      id,
      type: m.media_type,
      sha256: m.sha256,
      sizeBytes: Number(m.size_bytes),
      durationMs: m.duration_ms,
      width: m.width,
      height: m.height,
      url: `/device/v1/media/${id}`,
    };
  });

  const content = { vehicleId, timezone: settings.timezone, validFrom: first, validTo: last, media, days };
  return { ...content, hash: stableHash(content) };
}

/** Baut die Playlist und speichert eine neue Version, falls sich der Inhalt geändert hat. */
export async function rebuildPlaylist(ctx: AppContext, vehicleId: string): Promise<{ version: number; changed: boolean }> {
  return ctx.sql.begin(async (tx) => {
    // Pro Fahrzeug nur ein Aufbau gleichzeitig.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"playlist:" + vehicleId}))`;
    const [vehicle] = await tx`SELECT id FROM vehicles WHERE id = ${vehicleId}`;
    if (!vehicle) return { version: 0, changed: false };
    const composed = await composePlaylist(tx, vehicleId, ctx.now());
    const [latest] = await tx<{ version: number; content_hash: string }[]>`
      SELECT version, content_hash FROM playlists WHERE vehicle_id = ${vehicleId} ORDER BY version DESC LIMIT 1
    `;
    if (latest && latest.content_hash === composed.hash) return { version: latest.version, changed: false };
    const version = (latest?.version ?? 0) + 1;
    const { hash, ...content } = composed;
    const body: Playlist = { version, generatedAt: ctx.now().toISOString(), ...content };
    await tx`
      INSERT INTO playlists (vehicle_id, version, content_hash, valid_from, valid_to, body)
      VALUES (${vehicleId}, ${version}, ${hash}, ${content.validFrom}, ${content.validTo}, ${tx.json(body as never)})
    `;
    // Nur die letzten 20 Versionen aufheben.
    await tx`DELETE FROM playlists WHERE vehicle_id = ${vehicleId} AND version <= ${version - 20}`;
    return { version, changed: true };
  });
}

export async function latestPlaylist(db: Db, vehicleId: string): Promise<Playlist | null> {
  const [row] = await db<{ body: Playlist }[]>`
    SELECT body FROM playlists WHERE vehicle_id = ${vehicleId} ORDER BY version DESC LIMIT 1
  `;
  return row?.body ?? null;
}

export async function latestPlaylistVersion(db: Db, vehicleId: string): Promise<number | null> {
  const [row] = await db<{ version: number }[]>`
    SELECT max(version) AS version FROM playlists WHERE vehicle_id = ${vehicleId}
  `;
  return row?.version ?? null;
}
