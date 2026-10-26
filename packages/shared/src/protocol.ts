import { z } from "zod";
import { brightnessPointSchema } from "./settings";

/**
 * Protokoll zwischen Player-App und Server (Version 1).
 * Die Android-App bildet diese Strukturen in Kotlin nach.
 */

const isoInstant = z.iso.datetime({ offset: true });
const uuid = z.uuid();

export const pairingStartSchema = z.object({
  /** Öffentlicher Schlüssel (EC P-256, SPKI/DER, Base64) aus dem Android Keystore. */
  publicKey: z.string().min(80).max(400),
  deviceInfo: z.object({
    manufacturer: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    androidVersion: z.string().max(50).optional(),
    appVersion: z.string().max(50).optional(),
    serial: z.string().max(100).optional(),
  }),
});

export const pairingStatusSchema = z.object({
  pairingId: uuid,
  code: z.string(),
  status: z.enum(["pending", "claimed", "expired"]),
  expiresAt: isoInstant,
  deviceId: uuid.nullable(),
});

export const tokenRequestSchema = z.object({
  /** Vom Gerät mit seinem privaten Schlüssel signiertes JWT (ES256): sub = deviceId, aud = "taxiads-device-auth". */
  assertion: z.string().min(20).max(4000),
});

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  serverTime: isoInstant,
});

export const nowPlayingSchema = z.object({
  kind: z.enum(["campaign", "filler", "blank"]),
  campaignId: uuid.nullish(),
  creativeId: uuid.nullish(),
  fillerId: uuid.nullish(),
  mediaId: uuid.nullish(),
  startedAt: isoInstant,
});

export const heartbeatSchema = z.object({
  sentAt: isoInstant,
  playlistVersion: z.number().int().nullable(),
  configHash: z.string().max(100).nullable(),
  freeStorageBytes: z.number().int().nonnegative(),
  totalStorageBytes: z.number().int().nonnegative(),
  appVersion: z.string().max(50),
  batteryPercent: z.number().int().min(0).max(100).nullish(),
  charging: z.boolean().nullish(),
  temperatureC: z.number().nullish(),
  brightnessPercent: z.number().int().min(0).max(100).nullish(),
  nowPlaying: nowPlayingSchema.nullish(),
  pending: z.object({ playbackEvents: z.number().int().nonnegative(), gpsPoints: z.number().int().nonnegative() }).nullish(),
});

export const heartbeatResponseSchema = z.object({
  serverTime: isoInstant,
  playlistVersion: z.number().int().nullable(),
  configHash: z.string(),
});

const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullish(),
});

export const playbackEventSchema = z.object({
  /** Vom Gerät erzeugte UUID – macht wiederholte Uploads unschädlich. */
  id: uuid,
  vehicleId: uuid,
  playlistVersion: z.number().int().nullable(),
  kind: z.enum(["campaign", "filler", "blank"]),
  campaignId: uuid.nullish(),
  creativeId: uuid.nullish(),
  fillerId: uuid.nullish(),
  mediaId: uuid.nullish(),
  startedAt: isoInstant,
  plannedMs: z.number().int().nonnegative(),
  playedMs: z.number().int().nonnegative(),
  completed: z.boolean(),
  abortReason: z.string().max(100).nullish(),
  position: positionSchema.nullish(),
});

export const playbackBatchSchema = z.object({
  events: z.array(playbackEventSchema).min(1).max(1000),
});

export const gpsPointSchema = z.object({
  id: uuid,
  recordedAt: isoInstant,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullish(),
  speed: z.number().nonnegative().nullish(),
  heading: z.number().min(0).max(360).nullish(),
});

export const gpsBatchSchema = z.object({
  points: z.array(gpsPointSchema).min(1).max(2000),
});

export const ingestResultSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.number().int(),
});

export const deviceConfigSchema = z.object({
  hash: z.string(),
  deviceId: uuid,
  vehicleId: uuid.nullable(),
  vehicleLabel: z.string().nullable(),
  screenSlot: z.number().int().nullable(),
  timezone: z.string(),
  gpsIntervalSeconds: z.number().int(),
  heartbeatIntervalSeconds: z.number().int(),
  uploadIntervalSeconds: z.number().int(),
  brightnessSchedule: z.array(brightnessPointSchema),
});

const loopPieceSchema = z.object({
  kind: z.enum(["campaign", "filler", "blank"]),
  mediaId: uuid.optional(),
  campaignId: uuid.optional(),
  creativeId: uuid.optional(),
  fillerId: uuid.optional(),
  durationMs: z.number().int(),
});

const loopSlotSchema = z.object({
  kind: z.enum(["campaign", "filler"]),
  campaignId: uuid.optional(),
  durationMs: z.number().int(),
  variants: z.array(z.array(loopPieceSchema)),
});

export const playlistMediaSchema = z.object({
  id: uuid,
  type: z.enum(["image", "video"]),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Relativer Pfad, liefert eine Weiterleitung auf eine kurzlebige Download-URL. */
  url: z.string(),
});

export const playlistSchema = z.object({
  version: z.number().int(),
  vehicleId: uuid,
  generatedAt: isoInstant,
  timezone: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  media: z.array(playlistMediaSchema),
  days: z.array(
    z.object({
      date: z.string(),
      loopMs: z.number().int(),
      slots: z.array(loopSlotSchema),
    }),
  ),
});

export type PairingStart = z.infer<typeof pairingStartSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type PlaybackEvent = z.infer<typeof playbackEventSchema>;
export type GpsPoint = z.infer<typeof gpsPointSchema>;
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type PlaylistMedia = z.infer<typeof playlistMediaSchema>;
