import { z } from "zod";
import { validateBrightnessSchedule } from "./brightness";
import type { BookingRules } from "./booking";

export const brightnessPointSchema = z.object({
  time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Format HH:MM"),
  percent: z.number().int().min(0).max(100),
});

/** Alle im Admin-Bereich einstellbaren Systemwerte (ohne übergreifende Prüfungen). */
export const systemSettingsBaseSchema = z.object({
  timezone: z.string().min(1),
  loopSeconds: z.number().int().min(30).max(3600),
  bookingMinSeconds: z.number().int().min(1),
  bookingMaxSeconds: z.number().int().min(1),
  bookingStepSeconds: z.number().int().min(1),
  bookingMaxDays: z.number().int().min(1).max(3660),
  gpsIntervalSeconds: z.number().int().min(5).max(3600),
  heartbeatIntervalSeconds: z.number().int().min(15).max(3600),
  uploadIntervalSeconds: z.number().int().min(10).max(3600),
  gpsRawRetentionDays: z.number().int().min(1).max(3650),
  playlistDaysAhead: z.number().int().min(1).max(31),
  fillerImageSeconds: z.number().int().min(1).max(600),
  maxScreensPerVehicle: z.number().int().min(1).max(10),
  maxImageUploadMb: z.number().int().min(1).max(1024),
  maxVideoUploadMb: z.number().int().min(1).max(4096),
  brightnessSchedule: z.array(brightnessPointSchema).min(1).max(24),
});

export const systemSettingsSchema = systemSettingsBaseSchema.superRefine((s, ctx) => {
  if (s.bookingMinSeconds > s.bookingMaxSeconds) {
    ctx.addIssue({ code: "custom", path: ["bookingMinSeconds"], message: "Mindestdauer > Höchstdauer" });
  }
  for (const message of validateBrightnessSchedule(s.brightnessSchedule)) {
    ctx.addIssue({ code: "custom", path: ["brightnessSchedule"], message });
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: s.timezone });
  } catch {
    ctx.addIssue({ code: "custom", path: ["timezone"], message: "Unbekannte Zeitzone" });
  }
});

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const DEFAULT_SETTINGS: SystemSettings = {
  timezone: "Europe/Vienna",
  loopSeconds: 300,
  bookingMinSeconds: 5,
  bookingMaxSeconds: 60,
  bookingStepSeconds: 5,
  bookingMaxDays: 366,
  gpsIntervalSeconds: 30,
  heartbeatIntervalSeconds: 60,
  uploadIntervalSeconds: 60,
  gpsRawRetentionDays: 90,
  playlistDaysAhead: 7,
  fillerImageSeconds: 10,
  maxScreensPerVehicle: 2,
  maxImageUploadMb: 20,
  maxVideoUploadMb: 200,
  brightnessSchedule: [
    { time: "06:00", percent: 50 },
    { time: "16:00", percent: 5 },
  ],
};

export function bookingRules(s: SystemSettings): BookingRules {
  return {
    loopSeconds: s.loopSeconds,
    minSeconds: s.bookingMinSeconds,
    maxSeconds: s.bookingMaxSeconds,
    stepSeconds: s.bookingStepSeconds,
    maxDays: s.bookingMaxDays,
  };
}
