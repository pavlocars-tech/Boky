import { isIsoDate } from "@taxiads/shared";
import { z } from "zod";

export const isoDate = z.string().refine(isIsoDate, "Datum im Format JJJJ-MM-TT");
export const idParam = z.object({ id: z.uuid() });

export const campaignBody = z.object({
  name: z.string().trim().min(1).max(200),
  startDate: isoDate,
  endDate: isoDate,
  vehicleCount: z.number().int().min(1).max(100_000),
  secondsPerLoop: z.number().int().min(1).max(3600),
});

export const availabilityBody = z.object({
  startDate: isoDate,
  endDate: isoDate,
  secondsPerLoop: z.number().int().min(1).max(3600),
  /** Bei Änderung einer bestehenden Kampagne deren eigene Belegung nicht mitzählen. */
  campaignId: z.uuid().optional(),
});

export const uploadBody = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(100),
  sizeBytes: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const creativePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  archived: z.literal(true).optional(),
});
