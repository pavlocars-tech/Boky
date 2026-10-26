/**
 * Simuliertes Taxi-Tablet – zum Testen ohne Android-Gerät.
 *
 *   pnpm --filter @taxiads/api simulate-device [--api http://localhost:3000] [--name sim1] [--speed 10]
 *
 * Ablauf wie in der echten App: Schlüssel erzeugen, Kopplungscode anzeigen, auf Zuordnung warten,
 * Playlist laden, "abspielen" (beschleunigt um --speed), Ausspiel-Logs, GPS und Heartbeats senden.
 * Der Schlüssel wird unter .data/sim-<name>.json gespeichert, damit das Gerät beim Neustart gekoppelt bleibt.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { DeviceConfig, Playlist } from "@taxiads/shared";
import { SignJWT } from "jose";

const { values } = parseArgs({
  options: {
    api: { type: "string", default: "http://localhost:3000" },
    name: { type: "string", default: "sim1" },
    speed: { type: "string", default: "10" },
  },
});
const API = values.api!;
const SPEED = Number(values.speed);
const keyFile = `.data/sim-${values.name}.json`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}/device/v1${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

// ------------------------------------------------------------- Schlüssel & Kopplung
let state: { deviceId?: string; privateKeyPem: string };
if (existsSync(keyFile)) {
  state = JSON.parse(readFileSync(keyFile, "utf8"));
} else {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  state = { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  mkdirSync(".data", { recursive: true });
  writeFileSync(keyFile, JSON.stringify(state));
}
const privateKey = createPrivateKey(state.privateKeyPem);
const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");

if (!state.deviceId) {
  const start = await call<{ pairingId: string | null; code: string | null; deviceId: string | null }>("POST", "/pairing", {
    publicKey,
    deviceInfo: { manufacturer: "Simulator", model: "SM-X216B (simuliert)", androidVersion: "14", appVersion: "sim-1.0" },
  });
  if (start.data.deviceId) {
    state.deviceId = start.data.deviceId;
  } else {
    console.log(
      `\n  Kopplungscode: ${start.data.code}\n  Im Admin-Bereich unter Geräte -> "Gerät koppeln" eingeben (oder POST /admin/devices/claim).\n`,
    );
    while (!state.deviceId) {
      await sleep(3000);
      const p = await call<{ status: string; deviceId: string | null }>("GET", `/pairing/${start.data.pairingId}`);
      if (p.data.status === "expired") throw new Error("Code abgelaufen – bitte neu starten.");
      if (p.data.deviceId) state.deviceId = p.data.deviceId;
    }
  }
  writeFileSync(keyFile, JSON.stringify(state));
  console.log(`Gekoppelt als Gerät ${state.deviceId}`);
}

// ------------------------------------------------------------- Anmeldung
let token = "";
let tokenExpires = 0;
async function ensureToken() {
  if (Date.now() < tokenExpires - 60_000) return token;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(state.deviceId!)
    .setAudience("taxiads-device-auth")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .setJti(randomUUID())
    .sign(privateKey);
  const r = await call<{ accessToken: string; expiresIn: number }>("POST", "/token", { assertion });
  if (r.status !== 200) throw new Error(`Anmeldung fehlgeschlagen: ${JSON.stringify(r.data)}`);
  token = r.data.accessToken;
  tokenExpires = Date.now() + r.data.expiresIn * 1000;
  return token;
}

// ------------------------------------------------------------- Betrieb
let config = (await call<DeviceConfig>("GET", "/config", undefined, await ensureToken())).data;
let playlist: Playlist | null = null;
const pendingEvents: unknown[] = [];
const pendingGps: unknown[] = [];
let position = { lat: 48.2082, lon: 16.3738 }; // Stephansplatz
let nowPlaying: unknown = null;

async function loadPlaylist() {
  const r = await call<Playlist>(
    "GET",
    `/playlist${playlist ? `?version=${playlist.version}` : ""}`,
    undefined,
    await ensureToken(),
  );
  if (r.status === 200) {
    playlist = r.data;
    console.log(
      `Playlist v${playlist.version}: ${playlist.media.length} Dateien, Schleife ${playlist.days[0]!.loopMs / 1000}s, ${playlist.days[0]!.slots.length} Slots`,
    );
  } else if (r.status === 409) {
    console.log("Gerät ist keinem Fahrzeug zugeordnet.");
  }
}

async function heartbeat() {
  const r = await call<{ playlistVersion: number | null; configHash: string }>(
    "POST",
    "/heartbeat",
    {
      sentAt: new Date().toISOString(),
      playlistVersion: playlist?.version ?? null,
      configHash: config.hash,
      freeStorageBytes: 40_000_000_000,
      totalStorageBytes: 64_000_000_000,
      appVersion: "sim-1.0",
      batteryPercent: 100,
      charging: true,
      nowPlaying,
      pending: { playbackEvents: pendingEvents.length, gpsPoints: pendingGps.length },
    },
    await ensureToken(),
  );
  if (r.data.configHash !== config.hash) {
    config = (await call<DeviceConfig>("GET", "/config", undefined, await ensureToken())).data;
    console.log("Neue Konfiguration geladen.");
  }
  if (r.data.playlistVersion !== (playlist?.version ?? null)) await loadPlaylist();
}

async function upload() {
  if (pendingEvents.length) {
    const batch = pendingEvents.splice(0, 500);
    const r = await call<unknown>("POST", "/playback-events", { events: batch }, await ensureToken());
    if (r.status !== 200) pendingEvents.unshift(...batch);
    else console.log(`Ausspiel-Logs hochgeladen: ${JSON.stringify(r.data)}`);
  }
  if (pendingGps.length) {
    const batch = pendingGps.splice(0, 1000);
    const r = await call<unknown>("POST", "/gps", { points: batch }, await ensureToken());
    if (r.status !== 200) pendingGps.unshift(...batch);
  }
}

async function playLoop() {
  let loopCounter = 0;
  for (;;) {
    if (!playlist || !config.vehicleId) {
      await sleep(5000);
      continue;
    }
    const day = playlist.days[0]!;
    for (const slot of day.slots) {
      const variant = slot.variants[loopCounter % slot.variants.length]!;
      for (const piece of variant) {
        nowPlaying = {
          kind: piece.kind,
          campaignId: piece.campaignId,
          creativeId: piece.creativeId,
          fillerId: piece.fillerId,
          mediaId: piece.mediaId,
          startedAt: new Date().toISOString(),
        };
        const startedAt = new Date().toISOString();
        await sleep(piece.durationMs / SPEED);
        pendingEvents.push({
          id: randomUUID(),
          vehicleId: config.vehicleId,
          playlistVersion: playlist.version,
          kind: piece.kind,
          campaignId: piece.campaignId,
          creativeId: piece.creativeId,
          fillerId: piece.fillerId,
          mediaId: piece.mediaId,
          startedAt,
          plannedMs: piece.durationMs,
          playedMs: piece.durationMs,
          completed: true,
          position: { ...position, accuracy: 6 },
        });
        if (piece.kind === "campaign")
          console.log(
            `▶ Kampagne ${piece.campaignId?.slice(0, 8)} Motiv ${piece.creativeId?.slice(0, 8)} (${piece.durationMs / 1000}s)`,
          );
      }
    }
    loopCounter++;
  }
}

async function every(ms: () => number, fn: () => Promise<void>) {
  for (;;) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Offline? ${(err as Error).message}`);
    }
    await sleep(ms());
  }
}

await loadPlaylist();
void playLoop();
void every(
  () => (config.gpsIntervalSeconds * 1000) / SPEED,
  async () => {
    position = { lat: position.lat + (Math.random() - 0.5) * 0.002, lon: position.lon + (Math.random() - 0.5) * 0.003 };
    pendingGps.push({ id: randomUUID(), recordedAt: new Date().toISOString(), ...position, accuracy: 5, speed: 8 });
  },
);
void every(() => (config.heartbeatIntervalSeconds * 1000) / SPEED, heartbeat);
void every(() => (config.uploadIntervalSeconds * 1000) / SPEED, upload);
console.log(`Simulator läuft (Faktor ${SPEED}). Beenden mit Strg+C.`);
