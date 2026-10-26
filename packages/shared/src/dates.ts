/**
 * Kalendertage als "YYYY-MM-DD"-Strings. Gerechnet wird über Tagesnummern
 * (Tage seit 1970-01-01), damit Sommer-/Winterzeit keine Rolle spielt.
 */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export function toDayNumber(date: IsoDate): number {
  if (!isIsoDate(date)) throw new Error(`Ungültiges Datum: ${date}`);
  return Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
}

export function fromDayNumber(day: number): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Anzahl Tage inklusive Start und Ende. */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from) + 1;
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = toDayNumber(from); d <= toDayNumber(to); d++) out.push(fromDayNumber(d));
  return out;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Lokales Kalenderdatum eines Zeitpunkts in einer Zeitzone (z. B. Europe/Vienna). */
export function localDate(instant: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Lokale Uhrzeit eines Zeitpunkts als Minuten seit Mitternacht. */
export function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}
