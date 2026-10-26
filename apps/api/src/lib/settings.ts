import { createHash } from "node:crypto";
import { DEFAULT_SETTINGS, systemSettingsSchema, type SystemSettings } from "@taxiads/shared";
import type { Db } from "../db";
import { badRequest } from "./errors";

const CACHE_MS = 10_000;
let cache: { at: number; value: SystemSettings } | null = null;

/** Einstellungen = Standardwerte, überschrieben durch Werte in der Tabelle `settings`. */
export async function loadSettings(db: Db, { fresh = false } = {}): Promise<SystemSettings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  const parsed = systemSettingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Speichert geänderte Einstellungen; prüft dabei die Gesamtkonfiguration. */
export async function saveSettings(db: Db, patch: Partial<SystemSettings>, userId: string | null): Promise<SystemSettings> {
  const current = await loadSettings(db, { fresh: true });
  const parsed = systemSettingsSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) throw badRequest("invalid_settings", "Ungültige Einstellungen.", parsed.error.issues);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await db`
      INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${db.json(value as never)}, ${userId})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
  }
  invalidateSettingsCache();
  return parsed.data;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
