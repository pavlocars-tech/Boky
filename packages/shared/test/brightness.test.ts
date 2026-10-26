import { describe, expect, it } from "vitest";
import { brightnessAt, brightnessAtMinutes, validateBrightnessSchedule } from "../src/brightness";
import { addDays, daysInclusive, eachDay, isIsoDate, localDate, localMinutes } from "../src/dates";
import { DEFAULT_SETTINGS, systemSettingsSchema } from "../src/settings";

const schedule = DEFAULT_SETTINGS.brightnessSchedule; // 06:00 -> 50 %, 16:00 -> 5 %
const TZ = "Europe/Vienna";

describe("Helligkeitszeitplan", () => {
  it("Standard: 06–16 Uhr 50 %, sonst 5 %", () => {
    const at = (h: number, m = 0) => brightnessAtMinutes(schedule, h * 60 + m);
    expect(at(0)).toBe(5);
    expect(at(5, 59)).toBe(5);
    expect(at(6)).toBe(50);
    expect(at(15, 59)).toBe(50);
    expect(at(16)).toBe(5);
    expect(at(23, 59)).toBe(5);
  });

  it("berücksichtigt Sommerzeit (UTC+2) und Winterzeit (UTC+1) in Wien", () => {
    // Sommer: 04:30 UTC = 06:30 lokal
    expect(brightnessAt(schedule, new Date("2026-07-01T04:30:00Z"), TZ)).toBe(50);
    // Winter: 04:30 UTC = 05:30 lokal
    expect(brightnessAt(schedule, new Date("2026-12-01T04:30:00Z"), TZ)).toBe(5);
    // Sommer: 14:30 UTC = 16:30 lokal
    expect(brightnessAt(schedule, new Date("2026-07-01T14:30:00Z"), TZ)).toBe(5);
    // Winter: 14:30 UTC = 15:30 lokal
    expect(brightnessAt(schedule, new Date("2026-12-01T14:30:00Z"), TZ)).toBe(50);
  });

  it("am Tag der Zeitumstellung", () => {
    // 25.10.2026: um 03:00 Sommerzeit wird auf 02:00 Winterzeit zurückgestellt.
    expect(localMinutes(new Date("2026-10-25T05:00:00Z"), TZ)).toBe(6 * 60); // 06:00 MEZ
    expect(brightnessAt(schedule, new Date("2026-10-25T05:00:00Z"), TZ)).toBe(50);
    expect(brightnessAt(schedule, new Date("2026-10-25T04:59:00Z"), TZ)).toBe(5);
  });

  it("Zeitplan mit mehreren Punkten, unsortiert", () => {
    const s = [
      { time: "22:00", percent: 1 },
      { time: "07:30", percent: 80 },
      { time: "12:00", percent: 60 },
    ];
    expect(brightnessAtMinutes(s, 3 * 60)).toBe(1);
    expect(brightnessAtMinutes(s, 8 * 60)).toBe(80);
    expect(brightnessAtMinutes(s, 13 * 60)).toBe(60);
  });

  it("validiert Einträge", () => {
    expect(validateBrightnessSchedule([])).not.toEqual([]);
    expect(validateBrightnessSchedule([{ time: "25:00", percent: 5 }])).not.toEqual([]);
    expect(validateBrightnessSchedule([{ time: "06:00", percent: 101 }])).not.toEqual([]);
    expect(
      validateBrightnessSchedule([
        { time: "06:00", percent: 5 },
        { time: "06:00", percent: 6 },
      ]),
    ).not.toEqual([]);
    expect(validateBrightnessSchedule(schedule)).toEqual([]);
  });
});

describe("Datumsfunktionen", () => {
  it("lokales Datum in Wien", () => {
    expect(localDate(new Date("2026-10-25T22:30:00Z"), TZ)).toBe("2026-10-25"); // 23:30 MEZ
    expect(localDate(new Date("2026-10-25T23:30:00Z"), TZ)).toBe("2026-10-26"); // 00:30 MEZ
    expect(localDate(new Date("2026-07-01T22:30:00Z"), TZ)).toBe("2026-07-02"); // 00:30 MESZ
  });

  it("Tagesrechnung", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysInclusive("2026-11-01", "2026-11-30")).toBe(30);
    expect(eachDay("2026-10-24", "2026-10-26")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
  });
});

describe("Einstellungen", () => {
  it("Standardwerte sind gültig", () => {
    expect(systemSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it("lehnt unbekannte Zeitzone und Min > Max ab", () => {
    expect(systemSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, bookingMinSeconds: 90 }).success).toBe(false);
  });
});
