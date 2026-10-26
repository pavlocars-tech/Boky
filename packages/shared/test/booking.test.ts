import { describe, expect, it } from "vitest";
import {
  availableVehicles,
  dailyUsage,
  freeSeconds,
  mergeAdjacent,
  peakUsage,
  planCampaignChange,
  selectVehicles,
  validateBookingParams,
  type BookingRules,
  type VehicleLoad,
} from "../src/booking";

const LOOP = 300;
const rules: BookingRules = { loopSeconds: 300, minSeconds: 5, maxSeconds: 60, stepSeconds: 5, maxDays: 366 };

function vehicle(id: string, allocations: VehicleLoad["allocations"] = [], score = 0): VehicleLoad {
  return { vehicleId: id, allocations, score };
}

describe("Belegung", () => {
  it("summiert überlappende Zuteilungen pro Tag", () => {
    const allocs = [
      { from: "2026-11-01", to: "2026-11-10", seconds: 100 },
      { from: "2026-11-05", to: "2026-11-06", seconds: 50 },
    ];
    expect(dailyUsage(allocs, "2026-11-03", "2026-11-07")).toEqual([100, 100, 150, 150, 100]);
    expect(peakUsage(allocs, "2026-11-01", "2026-11-30")).toBe(150);
  });

  it("ignoriert Zuteilungen außerhalb des Zeitraums", () => {
    const allocs = [{ from: "2026-10-01", to: "2026-10-31", seconds: 300 }];
    expect(peakUsage(allocs, "2026-11-01", "2026-11-30")).toBe(0);
  });

  it("behandelt Start- und Endtag inklusive", () => {
    const allocs = [{ from: "2026-11-10", to: "2026-11-10", seconds: 20 }];
    expect(peakUsage(allocs, "2026-11-10", "2026-11-10")).toBe(20);
    expect(peakUsage(allocs, "2026-11-11", "2026-11-12")).toBe(0);
    expect(peakUsage(allocs, "2026-11-01", "2026-11-09")).toBe(0);
  });

  it("rechnet über Monats- und Jahresgrenzen und die Zeitumstellung", () => {
    const allocs = [{ from: "2026-10-24", to: "2027-01-02", seconds: 30 }];
    expect(dailyUsage(allocs, "2026-10-24", "2026-10-26")).toEqual([30, 30, 30]);
    expect(peakUsage(allocs, "2026-12-31", "2027-01-05")).toBe(30);
  });

  it("freie Sekunden = Schleife minus höchste Tagesbelegung", () => {
    const v = vehicle("a", [
      { from: "2026-11-01", to: "2026-11-30", seconds: 200 },
      { from: "2026-11-20", to: "2026-11-20", seconds: 90 },
    ]);
    expect(freeSeconds(v, "2026-11-01", "2026-11-19", LOOP)).toBe(100);
    expect(freeSeconds(v, "2026-11-01", "2026-11-30", LOOP)).toBe(10);
  });
});

describe("Verfügbarkeit", () => {
  const fleet = [
    vehicle("a", [{ from: "2026-11-01", to: "2026-11-30", seconds: 300 }]), // voll
    vehicle("b", [{ from: "2026-11-01", to: "2026-11-30", seconds: 280 }]), // 20 frei
    vehicle("c"), // leer
    vehicle("d", [{ from: "2026-11-15", to: "2026-11-15", seconds: 300 }]), // ein Tag voll
  ];

  it("zählt nur Fahrzeuge, die an jedem Tag genug frei haben", () => {
    const ids = (s: number, from = "2026-11-01", to = "2026-11-30") =>
      availableVehicles(fleet, from, to, s, LOOP).map((v) => v.vehicleId);
    expect(ids(20)).toEqual(["b", "c"]);
    expect(ids(25)).toEqual(["c"]);
    expect(ids(25, "2026-11-01", "2026-11-14")).toEqual(["c", "d"]);
    expect(ids(301)).toEqual([]);
  });

  it("verkauft genau die volle Schleife, aber keine Sekunde mehr", () => {
    const v = [vehicle("x", [{ from: "2026-11-01", to: "2026-11-30", seconds: 240 }])];
    expect(availableVehicles(v, "2026-11-01", "2026-11-30", 60, LOOP)).toHaveLength(1);
    expect(availableVehicles(v, "2026-11-01", "2026-11-30", 65, LOOP)).toHaveLength(0);
  });
});

describe("Auswahl der Fahrzeuge", () => {
  it("lehnt ab, wenn zu wenige Fahrzeuge frei sind, und nennt die freie Anzahl", () => {
    const fleet = [vehicle("a"), vehicle("b")];
    expect(selectVehicles(fleet, { from: "2026-11-01", to: "2026-11-30", seconds: 30, vehicleCount: 3 }, LOOP)).toEqual({
      ok: false,
      available: 2,
    });
  });

  it("bevorzugt stärker belegte Fahrzeuge (Best-Fit)", () => {
    const fleet = [
      vehicle("leer"),
      vehicle("halb", [{ from: "2026-11-01", to: "2026-11-30", seconds: 150 }]),
      vehicle("fast-voll", [{ from: "2026-11-01", to: "2026-11-30", seconds: 270 }]),
    ];
    const r = selectVehicles(fleet, { from: "2026-11-01", to: "2026-11-30", seconds: 30, vehicleCount: 2 }, LOOP);
    expect(r).toEqual({ ok: true, vehicleIds: ["fast-voll", "halb"], available: 3 });
  });

  it("entscheidet bei Gleichstand nach Score, dann nach ID", () => {
    const fleet = [vehicle("c", [], 0), vehicle("b", [], 1), vehicle("a", [], 0)];
    const r = selectVehicles(fleet, { from: "2026-11-01", to: "2026-11-01", seconds: 30, vehicleCount: 3 }, LOOP);
    expect(r.ok && r.vehicleIds).toEqual(["b", "a", "c"]);
  });

  it("bevorzugt vorgegebene Fahrzeuge, wenn sie passen", () => {
    const fleet = [vehicle("a"), vehicle("b", [{ from: "2026-11-01", to: "2026-11-30", seconds: 250 }]), vehicle("c")];
    const r = selectVehicles(fleet, { from: "2026-11-01", to: "2026-11-30", seconds: 30, vehicleCount: 1 }, LOOP, ["c"]);
    expect(r.ok && r.vehicleIds).toEqual(["c"]);
  });

  it("überbucht nie: viele Buchungen hintereinander bleiben unter der Schleifenlänge", () => {
    const fleet: VehicleLoad[] = Array.from({ length: 10 }, (_, i) => vehicle(`v${i}`));
    const seconds = [60, 45, 30, 20, 15, 10, 5, 60, 25, 35];
    let booked = 0;
    for (let round = 0; round < 50; round++) {
      const s = seconds[round % seconds.length]!;
      const count = 1 + (round % 4);
      const r = selectVehicles(fleet, { from: "2026-11-01", to: "2026-11-07", seconds: s, vehicleCount: count }, LOOP);
      if (!r.ok) continue;
      booked++;
      for (const id of r.vehicleIds) {
        fleet.find((v) => v.vehicleId === id)!.allocations.push({ from: "2026-11-01", to: "2026-11-07", seconds: s });
      }
    }
    expect(booked).toBeGreaterThan(5);
    for (const v of fleet) expect(peakUsage(v.allocations, "2026-11-01", "2026-11-07")).toBeLessThanOrEqual(LOOP);
  });
});

describe("Validierung", () => {
  const ok = { from: "2026-11-01", to: "2026-11-30", seconds: 15, vehicleCount: 10 };

  it("akzeptiert gültige Parameter", () => {
    expect(validateBookingParams(ok, rules, "2026-10-26")).toEqual([]);
  });

  it("prüft Mindest-, Höchstdauer und Schrittweite", () => {
    const fields = (seconds: number) => validateBookingParams({ ...ok, seconds }, rules, null).map((i) => i.message);
    expect(fields(4)).toContain("Mindestens 5 Sekunden.");
    expect(fields(65)).toContain("Höchstens 60 Sekunden.");
    expect(fields(17)).toContain("Nur in Schritten von 5 Sekunden buchbar.");
    expect(fields(2.5).length).toBeGreaterThan(0);
  });

  it("prüft Zeitraum und Starttag", () => {
    expect(validateBookingParams({ ...ok, to: "2026-10-31" }, rules, null)[0]?.field).toBe("to");
    expect(validateBookingParams(ok, rules, "2026-11-02")[0]?.field).toBe("from");
    expect(validateBookingParams({ ...ok, to: "2028-01-01" }, rules, null)[0]?.field).toBe("to");
  });

  it("prüft die Fahrzeuganzahl", () => {
    expect(validateBookingParams({ ...ok, vehicleCount: 0 }, rules, null)[0]?.field).toBe("vehicleCount");
  });
});

describe("Kampagnenänderung", () => {
  it("Neubuchung verteilt auf freie Fahrzeuge", () => {
    const plan = planCampaignChange({
      current: [],
      changeFrom: "2026-11-01",
      next: { from: "2026-11-01", to: "2026-11-30", seconds: 20, vehicleCount: 2 },
      vehicles: [vehicle("a"), vehicle("b"), vehicle("c")],
      loopSeconds: LOOP,
    });
    expect(plan).toEqual({
      ok: true,
      allocations: [
        { vehicleId: "a", from: "2026-11-01", to: "2026-11-30", seconds: 20 },
        { vehicleId: "b", from: "2026-11-01", to: "2026-11-30", seconds: 20 },
      ],
    });
  });

  it("laufende Kampagne: Vergangenheit bleibt, Zukunft wird mit neuen Werten verteilt", () => {
    const plan = planCampaignChange({
      current: [{ vehicleId: "b", from: "2026-11-01", to: "2026-11-30", seconds: 20 }],
      changeFrom: "2026-11-10",
      next: { from: "2026-11-01", to: "2026-11-30", seconds: 30, vehicleCount: 2 },
      vehicles: [vehicle("a"), vehicle("b"), vehicle("c")],
      loopSeconds: LOOP,
    });
    expect(plan.ok && plan.allocations).toEqual([
      { vehicleId: "a", from: "2026-11-10", to: "2026-11-30", seconds: 30 },
      { vehicleId: "b", from: "2026-11-01", to: "2026-11-09", seconds: 20 },
      { vehicleId: "b", from: "2026-11-10", to: "2026-11-30", seconds: 30 },
    ]);
  });

  it("verlängern ohne Änderung der Sekunden bleibt auf denselben Fahrzeugen und wird zusammengefasst", () => {
    const plan = planCampaignChange({
      current: [{ vehicleId: "c", from: "2026-11-01", to: "2026-11-30", seconds: 20 }],
      changeFrom: "2026-11-10",
      next: { from: "2026-11-01", to: "2026-12-31", seconds: 20, vehicleCount: 1 },
      vehicles: [vehicle("a"), vehicle("b"), vehicle("c")],
      loopSeconds: LOOP,
    });
    expect(plan.ok && plan.allocations).toEqual([{ vehicleId: "c", from: "2026-11-01", to: "2026-12-31", seconds: 20 }]);
  });

  it("weicht auf andere Fahrzeuge aus, wenn das bisherige im neuen Zeitraum voll ist", () => {
    const plan = planCampaignChange({
      current: [{ vehicleId: "a", from: "2026-11-01", to: "2026-11-30", seconds: 20 }],
      changeFrom: "2026-11-01",
      next: { from: "2026-11-01", to: "2026-12-31", seconds: 20, vehicleCount: 1 },
      vehicles: [vehicle("a", [{ from: "2026-12-01", to: "2026-12-31", seconds: 290 }]), vehicle("b")],
      loopSeconds: LOOP,
    });
    expect(plan.ok && plan.allocations).toEqual([{ vehicleId: "b", from: "2026-11-01", to: "2026-12-31", seconds: 20 }]);
  });

  it("scheitert, wenn die Erhöhung nicht passt", () => {
    const plan = planCampaignChange({
      current: [{ vehicleId: "a", from: "2026-11-01", to: "2026-11-30", seconds: 20 }],
      changeFrom: "2026-11-05",
      next: { from: "2026-11-01", to: "2026-11-30", seconds: 20, vehicleCount: 3 },
      vehicles: [vehicle("a"), vehicle("b")],
      loopSeconds: LOOP,
    });
    expect(plan).toEqual({ ok: false, available: 2 });
  });

  it("beenden gibt ab dem Stichtag alles frei", () => {
    const plan = planCampaignChange({
      current: [
        { vehicleId: "a", from: "2026-11-01", to: "2026-11-30", seconds: 20 },
        { vehicleId: "b", from: "2026-11-20", to: "2026-11-30", seconds: 20 },
      ],
      changeFrom: "2026-11-15",
      next: null,
      vehicles: [],
      loopSeconds: LOOP,
    });
    expect(plan.ok && plan.allocations).toEqual([{ vehicleId: "a", from: "2026-11-01", to: "2026-11-14", seconds: 20 }]);
  });

  it("verkürzen in die Vergangenheit hinein behält nur bereits gelaufene Tage", () => {
    const plan = planCampaignChange({
      current: [{ vehicleId: "a", from: "2026-11-01", to: "2026-11-30", seconds: 20 }],
      changeFrom: "2026-11-15",
      next: { from: "2026-11-01", to: "2026-11-10", seconds: 20, vehicleCount: 1 },
      vehicles: [vehicle("a")],
      loopSeconds: LOOP,
    });
    expect(plan.ok && plan.allocations).toEqual([{ vehicleId: "a", from: "2026-11-01", to: "2026-11-14", seconds: 20 }]);
  });
});

describe("mergeAdjacent", () => {
  it("fasst nur lückenlose Zeiträume mit gleichen Sekunden zusammen", () => {
    expect(
      mergeAdjacent([
        { vehicleId: "a", from: "2026-11-11", to: "2026-11-20", seconds: 10 },
        { vehicleId: "a", from: "2026-11-01", to: "2026-11-10", seconds: 10 },
        { vehicleId: "a", from: "2026-11-22", to: "2026-11-30", seconds: 10 },
        { vehicleId: "b", from: "2026-11-01", to: "2026-11-10", seconds: 10 },
        { vehicleId: "b", from: "2026-11-11", to: "2026-11-20", seconds: 15 },
      ]),
    ).toEqual([
      { vehicleId: "a", from: "2026-11-01", to: "2026-11-20", seconds: 10 },
      { vehicleId: "a", from: "2026-11-22", to: "2026-11-30", seconds: 10 },
      { vehicleId: "b", from: "2026-11-01", to: "2026-11-10", seconds: 10 },
      { vehicleId: "b", from: "2026-11-11", to: "2026-11-20", seconds: 15 },
    ]);
  });
});
