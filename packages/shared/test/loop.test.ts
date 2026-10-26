import { describe, expect, it } from "vitest";
import { buildLoop, composeFiller, loopDurationMs, type FillerInput, type SpotInput } from "../src/loop";

const img = (id: string): FillerInput => ({ fillerId: id, mediaId: `m-${id}`, mediaType: "image", durationMs: null });
const vid = (id: string, ms: number): FillerInput => ({ fillerId: id, mediaId: `m-${id}`, mediaType: "video", durationMs: ms });
const spot = (campaignId: string, seconds: number, creatives = 1): SpotInput => ({
  campaignId,
  seconds,
  creatives: Array.from({ length: creatives }, (_, i) => ({
    creativeId: `${campaignId}-c${i}`,
    mediaId: `${campaignId}-m${i}`,
    mediaType: "image" as const,
    durationMs: null,
  })),
});
const opts = { fillerImageMs: 10_000, minPieceMs: 3_000, maxFillerVariants: 6 };

function pieceSum(pieces: { durationMs: number }[]) {
  return pieces.reduce((s, p) => s + p.durationMs, 0);
}

describe("Schleife", () => {
  it("ohne Buchungen besteht die Schleife nur aus Füllinhalt", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [], fillers: [img("f1")] });
    expect(plan.loopMs).toBe(300_000);
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]!.kind).toBe("filler");
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("jede Kampagne läuft genau einmal pro Durchlauf mit ihrer gebuchten Dauer", () => {
    const plan = buildLoop({
      loopSeconds: 300,
      spots: [spot("A", 15), spot("B", 20), spot("C", 10)],
      fillers: [img("f1"), img("f2")],
    });
    const paid = plan.slots.filter((s) => s.kind === "campaign");
    expect(paid.map((s) => [s.campaignId, s.durationMs])).toEqual([
      ["A", 15_000],
      ["B", 20_000],
      ["C", 10_000],
    ]);
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("verteilt die Füllzeit gleichmäßig zwischen die Kampagnen", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 15), spot("B", 20), spot("C", 10)], fillers: [img("f")] });
    // 300 - 45 = 255 s Füller auf 3 Lücken: 85/85/85
    expect(plan.slots.map((s) => `${s.kind}:${s.durationMs / 1000}`)).toEqual([
      "campaign:15",
      "filler:85",
      "campaign:20",
      "filler:85",
      "campaign:10",
      "filler:85",
    ]);
  });

  it("verteilt Restsekunden auf die ersten Lücken", () => {
    const plan = buildLoop({
      loopSeconds: 300,
      spots: [spot("A", 10), spot("B", 10), spot("C", 10), spot("D", 10)],
      fillers: [img("f")],
    });
    // 260 s auf 4 Lücken: 65 je Lücke
    expect(plan.slots.filter((s) => s.kind === "filler").map((s) => s.durationMs / 1000)).toEqual([65, 65, 65, 65]);
    const plan2 = buildLoop({ loopSeconds: 300, spots: [spot("A", 5), spot("B", 5), spot("C", 5)], fillers: [img("f")] });
    // 285 / 3 = 95
    expect(plan2.slots.filter((s) => s.kind === "filler").map((s) => s.durationMs / 1000)).toEqual([95, 95, 95]);
    const plan3 = buildLoop({
      loopSeconds: 300,
      spots: [spot("A", 10), spot("B", 10), spot("C", 15), spot("D", 10)],
      fillers: [img("f")],
    });
    // 255 / 4 = 63 Rest 3
    expect(plan3.slots.filter((s) => s.kind === "filler").map((s) => s.durationMs / 1000)).toEqual([64, 64, 64, 63]);
  });

  it("ausverkaufte Schleife hat keine Füllslots", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 100), spot("B", 200)], fillers: [img("f")] });
    expect(plan.slots.every((s) => s.kind === "campaign")).toBe(true);
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("mehrere Motive einer Kampagne werden als Varianten abgewechselt", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 15, 3)], fillers: [img("f")] });
    const slot = plan.slots[0]!;
    expect(slot.variants.map((v) => v[0]!.creativeId)).toEqual(["A-c0", "A-c1", "A-c2"]);
    expect(slot.variants.every((v) => v.length === 1 && v[0]!.durationMs === 15_000)).toBe(true);
  });

  it("Kampagne ohne freigegebenes Motiv: ihre Zeit wird mit Füllinhalt belegt", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 15), spot("B", 30, 0)], fillers: [img("f")] });
    expect(plan.slots.filter((s) => s.kind === "campaign").map((s) => s.campaignId)).toEqual(["A"]);
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("pausierte Sekunden bleiben reserviert und werden aufgefüllt", () => {
    const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 100)], inactiveSeconds: 200, fillers: [img("f")] });
    expect(plan.loopMs).toBe(300_000);
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("Schleifenlänge ist Richtwert: bei Überbuchung nach Verkürzung wird die Schleife länger", () => {
    const plan = buildLoop({ loopSeconds: 240, spots: [spot("A", 200), spot("B", 100)], fillers: [img("f")] });
    expect(plan.loopMs).toBe(300_000);
    expect(plan.slots.every((s) => s.kind === "campaign")).toBe(true);
    expect(loopDurationMs(plan)).toBe(300_000);
  });

  it("jede Variante jedes Slots füllt den Slot exakt", () => {
    for (const fillers of [[img("a"), img("b")], [vid("v1", 12_400), vid("v2", 30_000)], [vid("v", 7_000), img("i")], []]) {
      const plan = buildLoop({ loopSeconds: 300, spots: [spot("A", 15), spot("B", 25), spot("C", 5)], fillers });
      for (const slot of plan.slots) {
        for (const variant of slot.variants) expect(pieceSum(variant)).toBe(slot.durationMs);
      }
      expect(loopDurationMs(plan)).toBe(300_000);
    }
  });
});

describe("Füllinhalte", () => {
  it("ohne Füllinhalte wird schwarz angezeigt", () => {
    expect(composeFiller(20_000, [], 0, opts)).toEqual([{ kind: "blank", durationMs: 20_000 }]);
  });

  it("Bilder teilen die Lücke in ca. 10-Sekunden-Stücke", () => {
    const pieces = composeFiller(25_000, [img("a"), img("b")], 0, opts);
    expect(pieces.map((p) => [p.fillerId, p.durationMs])).toEqual([
      ["a", 10_000],
      ["b", 10_000],
      ["a", 5_000],
    ]);
  });

  it("Videos, die passen, laufen vollständig; Rest mit Bildern", () => {
    const pieces = composeFiller(40_000, [vid("v", 30_000), img("i")], 0, opts);
    expect(pieces.map((p) => [p.fillerId, p.durationMs])).toEqual([
      ["v", 30_000],
      ["i", 10_000],
    ]);
  });

  it("kein winziger Rest: zu kurze Reststücke werden vermieden", () => {
    const pieces = composeFiller(31_000, [vid("v", 30_000), img("i")], 0, opts);
    // 1 s Rest wäre zu kurz -> Video wird übersprungen, ein einziges Bild füllt die Lücke
    expect(pieces).toEqual([{ kind: "filler", fillerId: "i", mediaId: "m-i", durationMs: 31_000 }]);
  });

  it("Videos und Bilder wechseln sich ab statt minutenlang dasselbe Bild", () => {
    const pieces = composeFiller(285_000, [vid("v", 20_000), img("i")], 0, opts);
    expect(pieces.slice(0, 4).map((p) => p.fillerId)).toEqual(["v", "i", "v", "i"]);
    expect(pieces.filter((p) => p.fillerId === "v")).toHaveLength(9);
    expect(Math.max(...pieces.filter((p) => p.fillerId === "i").map((p) => p.durationMs))).toBeLessThanOrEqual(25_000);
    expect(pieceSum(pieces)).toBe(285_000);
  });

  it("ein einzelnes Füllbild wird nicht in viele Stücke zerlegt", () => {
    expect(composeFiller(120_000, [img("i")], 0, opts)).toEqual([
      { kind: "filler", fillerId: "i", mediaId: "m-i", durationMs: 120_000 },
    ]);
  });

  it("nur Videos: kurzer Rest hängt am letzten Video (letztes Bild bleibt stehen)", () => {
    const pieces = composeFiller(31_000, [vid("v", 30_000)], 0, opts);
    expect(pieces).toEqual([{ kind: "filler", fillerId: "v", mediaId: "m-v", durationMs: 31_000 }]);
  });

  it("nur Videos und Lücke kürzer als jedes Video: Video wird gekürzt", () => {
    const pieces = composeFiller(8_000, [vid("v", 30_000)], 0, opts);
    expect(pieces).toEqual([{ kind: "filler", fillerId: "v", mediaId: "m-v", durationMs: 8_000 }]);
  });

  it("Varianten rotieren die Reihenfolge der Füllinhalte", () => {
    const plan = buildLoop({ loopSeconds: 60, spots: [], fillers: [img("a"), img("b"), img("c")] });
    const firsts = plan.slots[0]!.variants.map((v) => v[0]!.fillerId);
    expect(firsts).toEqual(["a", "b", "c"]);
  });
});
