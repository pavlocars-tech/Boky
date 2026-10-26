/**
 * Aufbau einer Schleife für ein Fahrzeug und einen Tag (rein, ohne Datenbank).
 *
 * Eine Schleife besteht aus Slots. Bezahlte Slots (Kampagnen) werden gleichmäßig
 * verteilt, die Lücken mit Füllinhalten aufgefüllt. Jeder Slot hat eine oder
 * mehrere Varianten; der Player spielt im n-ten Durchlauf die Variante
 * `n mod variants.length`. So wechseln sich die Motive einer Kampagne ab.
 */

export type MediaType = "image" | "video";

export interface CreativeInput {
  creativeId: string;
  mediaId: string;
  mediaType: MediaType;
  /** Bei Videos die Länge in ms, bei Bildern null. */
  durationMs: number | null;
}

export interface SpotInput {
  campaignId: string;
  seconds: number;
  /** Ausspielbare Motive (freigegeben, verarbeitet, nicht zu lang) in Rotationsreihenfolge. */
  creatives: CreativeInput[];
}

export interface FillerInput {
  fillerId: string;
  mediaId: string;
  mediaType: MediaType;
  durationMs: number | null;
}

export interface LoopPiece {
  kind: "campaign" | "filler" | "blank";
  mediaId?: string;
  campaignId?: string;
  creativeId?: string;
  fillerId?: string;
  /** Wie lange das Stück den Bildschirm belegt. Kürzere Videos halten das letzte Bild. */
  durationMs: number;
}

export interface LoopSlot {
  kind: "campaign" | "filler";
  campaignId?: string;
  durationMs: number;
  variants: LoopPiece[][];
}

export interface LoopPlan {
  loopMs: number;
  slots: LoopSlot[];
}

export interface LoopOptions {
  /** Standardanzeigedauer eines Füllbilds. */
  fillerImageMs?: number;
  /** Kürzere Reststücke werden an das vorherige Stück angehängt. */
  minPieceMs?: number;
  /** Höchstzahl unterschiedlicher Füller-Varianten pro Slot. */
  maxFillerVariants?: number;
}

export interface BuildLoopInput {
  /** Schleifenlänge (Richtwert aus den Einstellungen). */
  loopSeconds: number;
  /** Laufende Kampagnen an diesem Tag in Reihenfolge. Ohne ausspielbares Motiv wird ihre Zeit aufgefüllt. */
  spots: SpotInput[];
  /** Gebuchte, aber pausierte Sekunden – reserviert, werden mit Füllinhalten belegt. */
  inactiveSeconds?: number;
  fillers: FillerInput[];
  options?: LoopOptions;
}

/**
 * Die effektive Schleifenlänge ist die eingestellte Länge, mindestens aber die
 * Summe der gebuchten Sekunden. Wird die Schleifenlänge im Admin verkürzt,
 * laufen bestehende Buchungen so unverändert weiter (Schleifenlänge = Richtwert).
 */
export function effectiveLoopSeconds(loopSeconds: number, bookedSeconds: number): number {
  return Math.max(loopSeconds, bookedSeconds);
}

export function buildLoop(input: BuildLoopInput): LoopPlan {
  const opts = {
    fillerImageMs: input.options?.fillerImageMs ?? 10_000,
    minPieceMs: input.options?.minPieceMs ?? 3_000,
    maxFillerVariants: input.options?.maxFillerVariants ?? 6,
  };
  const playable = input.spots.filter((s) => s.creatives.length > 0 && s.seconds > 0);
  const booked = input.spots.reduce((sum, s) => sum + s.seconds, 0) + (input.inactiveSeconds ?? 0);
  const loopSeconds = effectiveLoopSeconds(input.loopSeconds, booked);
  const paidSeconds = playable.reduce((sum, s) => sum + s.seconds, 0);
  const fillerSeconds = loopSeconds - paidSeconds;

  const slots: LoopSlot[] = [];
  if (playable.length === 0) {
    slots.push(fillerSlot(loopSeconds * 1000, input.fillers, opts));
    return { loopMs: loopSeconds * 1000, slots };
  }

  const k = playable.length;
  const baseGap = Math.floor(fillerSeconds / k);
  const extra = fillerSeconds % k;
  playable.forEach((spot, i) => {
    slots.push({
      kind: "campaign",
      campaignId: spot.campaignId,
      durationMs: spot.seconds * 1000,
      variants: spot.creatives.map((c) => [
        {
          kind: "campaign",
          campaignId: spot.campaignId,
          creativeId: c.creativeId,
          mediaId: c.mediaId,
          durationMs: spot.seconds * 1000,
        },
      ]),
    });
    const gap = baseGap + (i < extra ? 1 : 0);
    if (gap > 0) slots.push(fillerSlot(gap * 1000, input.fillers, opts));
  });
  return { loopMs: loopSeconds * 1000, slots };
}

type ResolvedOptions = Required<LoopOptions>;

function fillerSlot(durationMs: number, fillers: FillerInput[], opts: ResolvedOptions): LoopSlot {
  const variantCount = Math.max(1, Math.min(opts.maxFillerVariants, fillers.length));
  const variants: LoopPiece[][] = [];
  const seen = new Set<string>();
  for (let v = 0; v < variantCount; v++) {
    const pieces = composeFiller(durationMs, fillers, v, opts);
    const key = JSON.stringify(pieces);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(pieces);
  }
  return { kind: "filler", durationMs, variants };
}

function rotate<T>(items: T[], by: number): T[] {
  if (items.length === 0) return items;
  const n = by % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

/**
 * Füllt `durationMs` exakt mit Füllinhalten. Videos und Bilder wechseln sich ab:
 * Video (wenn es vollständig passt) – Bild (ca. `fillerImageMs`) – Video – …
 * Ohne Bilder wird zum Schluss ein Video gekürzt; ohne Füllinhalte bleibt der Bildschirm schwarz ("blank").
 * Reststücke unter `minPieceMs` werden vermieden bzw. dem vorherigen Stück zugeschlagen.
 */
export function composeFiller(durationMs: number, fillers: FillerInput[], variant: number, opts: ResolvedOptions): LoopPiece[] {
  if (durationMs <= 0) return [];
  if (fillers.length === 0) return [{ kind: "blank", durationMs }];

  const videos = rotate(
    fillers.filter((f) => f.mediaType === "video" && (f.durationMs ?? 0) > 0),
    variant,
  );
  const images = rotate(
    fillers.filter((f) => f.mediaType === "image"),
    variant,
  );
  const pieces: LoopPiece[] = [];
  const piece = (f: FillerInput, ms: number): LoopPiece => ({
    kind: "filler",
    fillerId: f.fillerId,
    mediaId: f.mediaId,
    durationMs: ms,
  });
  let remaining = durationMs;
  let vi = 0;
  let ii = 0;
  let progressed = true;

  while (remaining > 0 && progressed) {
    progressed = false;
    for (let k = 0; k < videos.length; k++) {
      const v = videos[(vi + k) % videos.length]!;
      const d = v.durationMs!;
      const rest = remaining - d;
      if (d > remaining || (rest !== 0 && rest < opts.minPieceMs && images.length > 0)) continue;
      pieces.push(piece(v, d));
      remaining = rest;
      vi += k + 1;
      progressed = true;
      break;
    }
    if (remaining > 0 && images.length > 0) {
      let d = Math.min(opts.fillerImageMs, remaining);
      if (remaining - d < opts.minPieceMs) d = remaining;
      pieces.push(piece(images[ii % images.length]!, d));
      ii++;
      remaining -= d;
      progressed = true;
    }
  }

  if (remaining > 0 && remaining < opts.minPieceMs && pieces.length > 0) {
    pieces[pieces.length - 1]!.durationMs += remaining; // letztes Bild bleibt etwas länger stehen
    remaining = 0;
  }
  if (remaining > 0 && videos.length > 0) {
    pieces.push(piece(videos[vi % videos.length]!, remaining)); // nur Videos: das nächste wird gekürzt
    remaining = 0;
  }
  if (remaining > 0) pieces.push({ kind: "blank", durationMs: remaining });
  return mergeRepeatedImages(pieces, new Set(images.map((i) => i.mediaId)));
}

/** Dasselbe Bild mehrfach direkt hintereinander = ein längeres Stück. */
function mergeRepeatedImages(pieces: LoopPiece[], imageIds: Set<string>): LoopPiece[] {
  const out: LoopPiece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev && p.mediaId && prev.mediaId === p.mediaId && imageIds.has(p.mediaId)) prev.durationMs += p.durationMs;
    else out.push({ ...p });
  }
  return out;
}

/** Summe der Slotlängen – muss immer der Schleifenlänge entsprechen. */
export function loopDurationMs(plan: LoopPlan): number {
  return plan.slots.reduce((sum, s) => sum + s.durationMs, 0);
}
