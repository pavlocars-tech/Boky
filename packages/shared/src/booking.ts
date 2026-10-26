import { addDays, daysInclusive, maxDate, toDayNumber, type IsoDate } from "./dates";

/**
 * Buchungslogik (rein, ohne Datenbank).
 *
 * Grundregel: Für jedes Fahrzeug und jeden Kalendertag gilt
 *   Summe der gebuchten Sekunden aller Zuteilungen <= Schleifenlänge.
 */

/** Eine Zuteilung: Fahrzeug spielt von `from` bis `to` (inklusive) `seconds` Sekunden pro Schleife. */
export interface AllocationSpan {
  from: IsoDate;
  to: IsoDate;
  seconds: number;
}

export interface VehicleLoad {
  vehicleId: string;
  /** Zuteilungen anderer Kampagnen auf diesem Fahrzeug. */
  allocations: AllocationSpan[];
  /** Höher = bevorzugt bei Gleichstand (z. B. Online-Quote). */
  score?: number;
}

export interface BookingRules {
  loopSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  stepSeconds: number;
  maxDays: number;
}

export interface BookingParams {
  from: IsoDate;
  to: IsoDate;
  seconds: number;
  vehicleCount: number;
}

/** Höchste Tagesbelegung (Sekunden) im Zeitraum [from, to]. */
export function peakUsage(allocations: AllocationSpan[], from: IsoDate, to: IsoDate): number {
  return Math.max(0, ...dailyUsage(allocations, from, to));
}

/** Belegung je Tag im Zeitraum [from, to]; Index 0 = `from`. */
export function dailyUsage(allocations: AllocationSpan[], from: IsoDate, to: IsoDate): number[] {
  const start = toDayNumber(from);
  const end = toDayNumber(to);
  if (end < start) return [];
  const delta = new Array<number>(end - start + 2).fill(0);
  for (const a of allocations) {
    const s = Math.max(toDayNumber(a.from), start);
    const e = Math.min(toDayNumber(a.to), end);
    if (s > e) continue;
    delta[s - start]! += a.seconds;
    delta[e - start + 1]! -= a.seconds;
  }
  const out: number[] = [];
  let running = 0;
  for (let i = 0; i <= end - start; i++) {
    running += delta[i]!;
    out.push(running);
  }
  return out;
}

/** Freie Sekunden, die an jedem Tag des Zeitraums verfügbar sind. */
export function freeSeconds(vehicle: VehicleLoad, from: IsoDate, to: IsoDate, loopSeconds: number): number {
  return Math.max(0, loopSeconds - peakUsage(vehicle.allocations, from, to));
}

export interface AvailableVehicle {
  vehicleId: string;
  free: number;
  score: number;
}

/** Alle Fahrzeuge, die im gesamten Zeitraum mindestens `seconds` frei haben. */
export function availableVehicles(
  vehicles: VehicleLoad[],
  from: IsoDate,
  to: IsoDate,
  seconds: number,
  loopSeconds: number,
): AvailableVehicle[] {
  const out: AvailableVehicle[] = [];
  for (const v of vehicles) {
    const free = freeSeconds(v, from, to, loopSeconds);
    if (free >= seconds) out.push({ vehicleId: v.vehicleId, free, score: v.score ?? 0 });
  }
  return out;
}

export type SelectionResult = { ok: true; vehicleIds: string[]; available: number } | { ok: false; available: number };

/**
 * Wählt `vehicleCount` Fahrzeuge für eine Buchung aus.
 *
 * Reihenfolge:
 *  1. bevorzugte Fahrzeuge (z. B. bisherige Fahrzeuge einer geänderten Kampagne)
 *  2. Best-Fit: am wenigsten freie Zeit, die noch reicht – so bleiben große
 *     Lücken für große Buchungen erhalten
 *  3. höherer Score (z. B. zuverlässig online)
 *  4. Fahrzeug-ID (deterministisch)
 */
export function selectVehicles(
  vehicles: VehicleLoad[],
  params: Pick<BookingParams, "from" | "to" | "seconds" | "vehicleCount">,
  loopSeconds: number,
  preferredVehicleIds: string[] = [],
): SelectionResult {
  const candidates = availableVehicles(vehicles, params.from, params.to, params.seconds, loopSeconds);
  if (candidates.length < params.vehicleCount) return { ok: false, available: candidates.length };
  const preferred = new Set(preferredVehicleIds);
  candidates.sort((a, b) => {
    const pa = preferred.has(a.vehicleId) ? 0 : 1;
    const pb = preferred.has(b.vehicleId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.free !== b.free) return a.free - b.free;
    if (a.score !== b.score) return b.score - a.score;
    return a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : 0;
  });
  return {
    ok: true,
    vehicleIds: candidates.slice(0, params.vehicleCount).map((c) => c.vehicleId),
    available: candidates.length,
  };
}

export interface ValidationIssue {
  field: keyof BookingParams;
  message: string;
}

/**
 * Prüft Buchungsparameter gegen die Regeln aus dem Admin-Bereich.
 * `earliestStart` ist der früheste erlaubte Starttag (bei neuen Buchungen: heute).
 */
export function validateBookingParams(
  params: BookingParams,
  rules: BookingRules,
  earliestStart: IsoDate | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { seconds, vehicleCount, from, to } = params;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    issues.push({ field: "seconds", message: "Sekunden müssen eine positive ganze Zahl sein." });
  } else {
    if (seconds < rules.minSeconds) issues.push({ field: "seconds", message: `Mindestens ${rules.minSeconds} Sekunden.` });
    if (seconds > rules.maxSeconds) issues.push({ field: "seconds", message: `Höchstens ${rules.maxSeconds} Sekunden.` });
    if (seconds > rules.loopSeconds) {
      issues.push({ field: "seconds", message: `Höchstens die Schleifenlänge von ${rules.loopSeconds} Sekunden.` });
    }
    if (rules.stepSeconds > 1 && seconds % rules.stepSeconds !== 0) {
      issues.push({ field: "seconds", message: `Nur in Schritten von ${rules.stepSeconds} Sekunden buchbar.` });
    }
  }
  if (!Number.isInteger(vehicleCount) || vehicleCount < 1) {
    issues.push({ field: "vehicleCount", message: "Mindestens ein Fahrzeug." });
  }
  if (to < from) {
    issues.push({ field: "to", message: "Das Ende darf nicht vor dem Start liegen." });
  } else if (daysInclusive(from, to) > rules.maxDays) {
    issues.push({ field: "to", message: `Höchstens ${rules.maxDays} Tage pro Buchung.` });
  }
  if (earliestStart && from < earliestStart) {
    issues.push({ field: "from", message: "Der Start darf nicht in der Vergangenheit liegen." });
  }
  return issues;
}

export interface CampaignAllocation extends AllocationSpan {
  vehicleId: string;
}

export interface ChangePlanInput {
  /** Bisherige Zuteilungen dieser Kampagne. */
  current: CampaignAllocation[];
  /** Ab diesem Tag gelten die neuen Werte (meist: heute oder Kampagnenstart). */
  changeFrom: IsoDate;
  /** Neue Parameter, `null` = ab `changeFrom` alles freigeben (beenden). */
  next: BookingParams | null;
  /** Buchbare Fahrzeuge mit den Zuteilungen ANDERER Kampagnen. */
  vehicles: VehicleLoad[];
  loopSeconds: number;
}

export type ChangePlan = { ok: true; allocations: CampaignAllocation[] } | { ok: false; available: number };

/**
 * Plant die Zuteilungen einer Kampagne nach einer Änderung (oder Neubuchung,
 * dann ist `current` leer).
 *
 * - Zuteilungen vor `changeFrom` bleiben unverändert (Vergangenheit wird nicht umgeschrieben).
 * - Ab `changeFrom` wird mit den neuen Werten neu verteilt; bisherige Fahrzeuge werden bevorzugt,
 *   damit eine laufende Kampagne möglichst auf denselben Fahrzeugen bleibt.
 */
export function planCampaignChange(input: ChangePlanInput): ChangePlan {
  const { current, changeFrom, next, vehicles, loopSeconds } = input;
  const kept: CampaignAllocation[] = [];
  const lastPastDay = addDays(changeFrom, -1);
  for (const a of current) {
    if (a.from > lastPastDay) continue;
    kept.push({ ...a, to: a.to < lastPastDay ? a.to : lastPastDay });
  }
  if (!next) return { ok: true, allocations: kept };

  const from = maxDate(next.from, changeFrom);
  if (from > next.to) return { ok: true, allocations: kept };

  const preferred = current.filter((a) => a.to >= changeFrom).map((a) => a.vehicleId);
  const selection = selectVehicles(vehicles, { ...next, from }, loopSeconds, preferred);
  if (!selection.ok) return { ok: false, available: selection.available };
  return {
    ok: true,
    allocations: mergeAdjacent([
      ...kept,
      ...selection.vehicleIds.map((vehicleId) => ({ vehicleId, from, to: next.to, seconds: next.seconds })),
    ]),
  };
}

/** Fasst direkt aneinander anschließende Zuteilungen mit gleichem Fahrzeug und gleicher Dauer zusammen. */
export function mergeAdjacent(allocations: CampaignAllocation[]): CampaignAllocation[] {
  const sorted = [...allocations].sort((a, b) =>
    a.vehicleId === b.vehicleId ? (a.from < b.from ? -1 : 1) : a.vehicleId < b.vehicleId ? -1 : 1,
  );
  const out: CampaignAllocation[] = [];
  for (const a of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.vehicleId === a.vehicleId && prev.seconds === a.seconds && addDays(prev.to, 1) === a.from) {
      prev.to = a.to;
    } else {
      out.push({ ...a });
    }
  }
  return out;
}
