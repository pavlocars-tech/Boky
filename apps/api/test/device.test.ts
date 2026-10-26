import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs";
import { applyRetention } from "../src/services/maintenance";
import {
  api,
  createAdmin,
  createTestEnv,
  createVehicles,
  deviceAssertion,
  deviceKeys,
  pairDevice,
  resetDb,
  type Session,
  type TestEnv,
} from "./helpers";

let env: TestEnv;
let admin: Session;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetDb(env.ctx);
  env.clock.now = new Date("2026-11-02T10:00:00Z");
  admin = await createAdmin(env);
});

describe("Kopplung und Anmeldung", () => {
  it("Gerät zeigt Code, Admin ordnet zu, Gerät meldet sich mit eigenem Schlüssel an", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const config = await api(env, "GET", "/device/v1/config", { token: device.token });
    expect(config.status).toBe(200);
    expect(config.json).toMatchObject({
      vehicleId: vehicle,
      vehicleLabel: "W-TAXI-001",
      screenSlot: 1,
      timezone: "Europe/Vienna",
      gpsIntervalSeconds: 30,
      brightnessSchedule: [
        { time: "06:00", percent: 50 },
        { time: "16:00", percent: 5 },
      ],
    });
  });

  it("zwei Bildschirme pro Taxi, ein dritter wird abgelehnt", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    await pairDevice(env, admin, vehicle!);
    const second = await pairDevice(env, admin, vehicle!);
    const cfg = await api(env, "GET", "/device/v1/config", { token: second.token });
    expect(cfg.json.screenSlot).toBe(2);

    const { publicKeyB64 } = deviceKeys();
    const start = await api(env, "POST", "/device/v1/pairing", { body: { publicKey: publicKeyB64, deviceInfo: {} } });
    const third = await api(env, "POST", "/admin/devices/claim", {
      session: admin,
      body: { code: start.json.code, vehicleId: vehicle },
    });
    expect(third.status).toBe(409);
  });

  it("Tausch eines defekten Tablets mit replace", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const old = await pairDevice(env, admin, vehicle!, 1);
    const { publicKeyB64 } = deviceKeys();
    const start = await api(env, "POST", "/device/v1/pairing", { body: { publicKey: publicKeyB64, deviceInfo: {} } });
    const r = await api(env, "POST", "/admin/devices/claim", {
      session: admin,
      body: { code: start.json.code, vehicleId: vehicle, screenSlot: 1, replace: true },
    });
    expect(r.status).toBe(201);
    const oldCfg = await api(env, "GET", "/device/v1/config", { token: old.token });
    expect(oldCfg.json.vehicleId).toBeNull();
  });

  it("falscher Schlüssel, falscher Code und abgelaufene Kopplung werden abgelehnt", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const other = deviceKeys();
    const forged = await api(env, "POST", "/device/v1/token", {
      body: { assertion: await deviceAssertion(device.deviceId, other.privateKey, env.clock.now) },
    });
    expect(forged.status).toBe(401);
    expect(
      (await api(env, "POST", "/admin/devices/claim", { session: admin, body: { code: "000000", vehicleId: vehicle } })).status,
    ).toBe(404);

    const k = deviceKeys();
    const start = await api(env, "POST", "/device/v1/pairing", { body: { publicKey: k.publicKeyB64, deviceInfo: {} } });
    env.clock.now = new Date(env.clock.now.getTime() + 31 * 60_000);
    expect((await api(env, "GET", `/device/v1/pairing/${start.json.pairingId}`)).json.status).toBe("expired");
    expect(
      (await api(env, "POST", "/admin/devices/claim", { session: admin, body: { code: start.json.code, vehicleId: vehicle } }))
        .status,
    ).toBe(404);
  });

  it("Gerät mit falsch gehender Uhr erhält die Serverzeit zur Korrektur", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const r = await api(env, "POST", "/device/v1/token", {
      body: {
        assertion: await deviceAssertion(device.deviceId, device.privateKey, new Date(env.clock.now.getTime() - 3 * 3_600_000)),
      },
    });
    expect(r.status).toBe(401);
    expect(r.json.details.serverTime).toBe(env.clock.now.toISOString());
  });

  it("gesperrte Geräte verlieren sofort den Zugriff", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    await api(env, "PATCH", `/admin/devices/${device.deviceId}`, { session: admin, body: { status: "blocked" } });
    expect((await api(env, "GET", "/device/v1/config", { token: device.token })).status).toBe(401);
    const again = await api(env, "POST", "/device/v1/token", {
      body: { assertion: await deviceAssertion(device.deviceId, device.privateKey, env.clock.now) },
    });
    expect(again.status).toBe(403);
  });

  it("abgelaufenes Zugriffstoken wird abgelehnt", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    env.clock.now = new Date(env.clock.now.getTime() + 16 * 60_000);
    expect((await api(env, "GET", "/device/v1/config", { token: device.token })).status).toBe(401);
  });
});

describe("Lebenszeichen, Playlist, Logs und GPS", () => {
  it("Heartbeat meldet Online-Status und nennt die aktuelle Playlist-Version", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    await drainJobs(env.ctx);
    const hb = await api(env, "POST", "/device/v1/heartbeat", {
      token: device.token,
      body: {
        sentAt: env.clock.now.toISOString(),
        playlistVersion: null,
        configHash: null,
        freeStorageBytes: 50_000_000_000,
        totalStorageBytes: 64_000_000_000,
        appVersion: "1.0.0",
        brightnessPercent: 50,
        nowPlaying: { kind: "filler", startedAt: env.clock.now.toISOString() },
      },
    });
    expect(hb.status).toBe(200);
    expect(hb.json.playlistVersion).toBe(1);
    const devices = await api(env, "GET", "/admin/devices", { session: admin });
    expect(devices.json[0]).toMatchObject({ online: true, freeStorageBytes: 50_000_000_000, vehicleLabel: "W-TAXI-001" });

    env.clock.now = new Date(env.clock.now.getTime() + 10 * 60_000);
    const later = await api(env, "GET", "/admin/devices", { session: admin });
    expect(later.json[0].online).toBe(false);
  });

  it("Playlist: 304, wenn die Version schon vorhanden ist", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const p = await api(env, "GET", "/device/v1/playlist", { token: device.token });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({
      vehicleId: vehicle,
      timezone: "Europe/Vienna",
      validFrom: "2026-11-02",
      validTo: "2026-11-08",
    });
    const same = await api(env, "GET", "/device/v1/playlist", {
      token: device.token,
      query: { version: String(p.json.version) },
    });
    expect(same.status).toBe(304);
  });

  it("Ausspiel-Logs: idempotent, nur für eigene Fahrzeuge, alte Monate werden angelegt", async () => {
    const [vehicle, otherVehicle] = await createVehicles(env, admin, 2);
    const device = await pairDevice(env, admin, vehicle!);
    const event = (overrides: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      vehicleId: vehicle,
      playlistVersion: 1,
      kind: "campaign",
      campaignId: randomUUID(),
      creativeId: randomUUID(),
      mediaId: randomUUID(),
      startedAt: "2026-11-02T09:59:00Z",
      plannedMs: 15000,
      playedMs: 15000,
      completed: true,
      position: { lat: 48.2082, lon: 16.3738, accuracy: 8 },
      ...overrides,
    });
    const batch = [
      event(),
      event({ completed: false, playedMs: 4000, abortReason: "screen_off" }),
      event({ startedAt: "2026-08-15T12:00:00Z", position: null }), // offline seit Monaten
      event({ vehicleId: otherVehicle }), // fremdes Fahrzeug
      event({ startedAt: "2030-01-01T00:00:00Z" }), // kaputte Uhr
    ];
    const r1 = await api(env, "POST", "/device/v1/playback-events", { token: device.token, body: { events: batch } });
    expect(r1.json).toEqual({ accepted: 3, duplicates: 0, rejected: 2 });
    // erneuter Upload (z. B. Antwort ging im Funkloch verloren)
    const r2 = await api(env, "POST", "/device/v1/playback-events", { token: device.token, body: { events: batch } });
    expect(r2.json).toEqual({ accepted: 0, duplicates: 3, rejected: 2 });
    const [{ n, aborted }] = (await env.ctx.sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT completed)::int AS aborted FROM playback_events
    `) as unknown as [{ n: number; aborted: number }];
    expect(n).toBe(3);
    expect(aborted).toBe(1);
    const [pos] = await env.ctx.sql`
      SELECT ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lon FROM playback_events WHERE position IS NOT NULL LIMIT 1
    `;
    expect(pos).toMatchObject({ lat: 48.2082, lon: 16.3738 });
  });

  it("nach Umbau in ein anderes Taxi werden alte Logs dem alten Fahrzeug zugeordnet", async () => {
    const [a, b] = await createVehicles(env, admin, 2);
    const device = await pairDevice(env, admin, a!);
    await api(env, "PATCH", `/admin/devices/${device.deviceId}`, { session: admin, body: { vehicleId: b } });
    const r = await api(env, "POST", "/device/v1/playback-events", {
      token: device.token,
      body: {
        events: [
          {
            id: randomUUID(),
            vehicleId: a,
            playlistVersion: 1,
            kind: "filler",
            startedAt: "2026-11-02T09:00:00Z",
            plannedMs: 10000,
            playedMs: 10000,
            completed: true,
          },
        ],
      },
    });
    expect(r.json.accepted).toBe(1);
  });

  it("GPS: Batch-Upload, letzte Position, Löschfrist", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const points = [
      { id: randomUUID(), recordedAt: "2026-11-02T09:58:00Z", lat: 48.2, lon: 16.37 },
      { id: randomUUID(), recordedAt: "2026-11-02T09:58:30Z", lat: 48.21, lon: 16.38, speed: 8.3, heading: 90, accuracy: 5 },
      { id: randomUUID(), recordedAt: "2026-07-01T08:00:00Z", lat: 48.19, lon: 16.36 }, // älter als 90 Tage
    ];
    const r = await api(env, "POST", "/device/v1/gps", { token: device.token, body: { points } });
    expect(r.json).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });
    expect((await api(env, "POST", "/device/v1/gps", { token: device.token, body: { points } })).json.duplicates).toBe(3);

    const devices = await api(env, "GET", "/admin/devices", { session: admin });
    expect(devices.json[0]).toMatchObject({ lat: 48.21, lon: 16.38 });

    const result = await applyRetention(env.ctx);
    expect(result.partitionsDropped).toContain("gps_points_202607");
    const [{ n }] = (await env.ctx.sql`SELECT count(*)::int AS n FROM gps_points`) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });

  it("Mediendateien gibt es nur für Inhalte der eigenen Playlist", async () => {
    const [vehicle] = await createVehicles(env, admin, 1);
    const device = await pairDevice(env, admin, vehicle!);
    const r = await api(env, "GET", `/device/v1/media/${randomUUID()}`, { token: device.token });
    expect(r.status).toBe(404);
  });
});
