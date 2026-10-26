import { localMinutes } from "./dates";

/**
 * Helligkeitszeitplan als Liste von Umschaltpunkten in lokaler Uhrzeit.
 * Jeder Eintrag gilt ab `time` bis zum nächsten Eintrag (über Mitternacht hinweg).
 * Beispiel: [{ time: "06:00", percent: 50 }, { time: "16:00", percent: 5 }]
 */
export interface BrightnessPoint {
  time: string; // "HH:MM"
  percent: number; // 0–100
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(time: string): number {
  const m = TIME.exec(time);
  if (!m) throw new Error(`Ungültige Uhrzeit: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function validateBrightnessSchedule(schedule: BrightnessPoint[]): string[] {
  const issues: string[] = [];
  if (schedule.length === 0) issues.push("Mindestens ein Eintrag.");
  const seen = new Set<string>();
  for (const p of schedule) {
    if (!TIME.test(p.time)) issues.push(`Ungültige Uhrzeit: ${p.time}`);
    if (seen.has(p.time)) issues.push(`Uhrzeit doppelt: ${p.time}`);
    seen.add(p.time);
    if (!Number.isInteger(p.percent) || p.percent < 0 || p.percent > 100) {
      issues.push(`Helligkeit muss zwischen 0 und 100 % liegen: ${p.percent}`);
    }
  }
  return issues;
}

/** Helligkeit zu einer lokalen Uhrzeit (Minuten seit Mitternacht). */
export function brightnessAtMinutes(schedule: BrightnessPoint[], minutes: number): number {
  const sorted = [...schedule].sort((a, b) => parseTime(a.time) - parseTime(b.time));
  if (sorted.length === 0) throw new Error("Leerer Zeitplan");
  let current = sorted[sorted.length - 1]!; // gilt vom Vortag weiter
  for (const p of sorted) {
    if (parseTime(p.time) <= minutes) current = p;
  }
  return current.percent;
}

/** Helligkeit zu einem Zeitpunkt in der angegebenen Zeitzone (inkl. Sommer-/Winterzeit). */
export function brightnessAt(schedule: BrightnessPoint[], instant: Date, timeZone: string): number {
  return brightnessAtMinutes(schedule, localMinutes(instant, timeZone));
}
