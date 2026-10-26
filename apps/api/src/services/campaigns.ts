import {
  addDays,
  bookingRules,
  maxDate,
  planCampaignChange,
  validateBookingParams,
  type BookingParams,
  type IsoDate,
} from "@taxiads/shared";
import type { Actor, AppContext } from "../context";
import { one, type Db } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { loadSettings } from "../lib/settings";
import { loadVehicleLoads, lockBookings, today as todayOf } from "./booking";
import { requestPlaylistRebuild } from "./playlists";

export type CampaignStatus = "draft" | "booked" | "paused" | "ended" | "cancelled";
export type CampaignPhase = "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled";

export interface CampaignRow {
  id: string;
  customer_id: string;
  name: string;
  start_date: IsoDate;
  end_date: IsoDate;
  vehicle_count: number;
  seconds_per_loop: number;
  status: CampaignStatus;
  booked_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Anzeigestatus aus gespeichertem Status und heutigem Datum. */
export function campaignPhase(c: Pick<CampaignRow, "status" | "start_date" | "end_date">, today: IsoDate): CampaignPhase {
  switch (c.status) {
    case "draft":
      return "draft";
    case "cancelled":
      return "cancelled";
    case "ended":
      return "completed";
    default:
      if (c.end_date < today) return "completed";
      if (c.status === "paused") return "paused";
      return c.start_date > today ? "scheduled" : "running";
  }
}

export function serializeCampaign(c: CampaignRow & { allocated_vehicles?: number; customer_name?: string }, today: IsoDate) {
  return {
    id: c.id,
    customerId: c.customer_id,
    customerName: c.customer_name,
    name: c.name,
    startDate: c.start_date,
    endDate: c.end_date,
    vehicleCount: c.vehicle_count,
    secondsPerLoop: c.seconds_per_loop,
    status: c.status,
    phase: campaignPhase(c, today),
    allocatedVehicles: c.allocated_vehicles ?? null,
    bookedAt: c.booked_at,
    endedAt: c.ended_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export async function getCampaign(db: Db, actor: Actor, id: string, { forUpdate = false } = {}): Promise<CampaignRow> {
  const rows = forUpdate
    ? await db<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id} FOR UPDATE`
    : await db<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`;
  const c = rows[0];
  // Fremde Kampagnen sind für Kunden "nicht vorhanden" – keine Rückschlüsse auf andere Kunden.
  if (!c || (actor.role === "customer" && c.customer_id !== actor.customerId)) throw notFound("Kampagne nicht gefunden.");
  return c;
}

function issuesToError(issues: { field: string; message: string }[]) {
  return badRequest("invalid_booking", issues.map((i) => i.message).join(" "), issues);
}

/**
 * Verteilt die Kampagne mit den neuen Parametern auf Fahrzeuge (ab heute).
 * Muss innerhalb einer Transaktion laufen. Gibt die betroffenen Fahrzeuge zurück.
 */
async function reallocate(
  tx: Db,
  campaignId: string,
  next: BookingParams | null,
  changeFrom: IsoDate,
  loopSeconds: number,
  now: Date,
) {
  await lockBookings(tx);
  const current = await tx<{ vehicle_id: string; start_date: string; end_date: string; seconds_per_loop: number }[]>`
    SELECT vehicle_id, start_date, end_date, seconds_per_loop FROM allocations WHERE campaign_id = ${campaignId}
  `;
  const from = next ? maxDate(next.from, changeFrom) : changeFrom;
  const loads = next && from <= next.to ? await loadVehicleLoads(tx, from, next.to, campaignId, now) : [];
  const plan = planCampaignChange({
    current: current.map((a) => ({ vehicleId: a.vehicle_id, from: a.start_date, to: a.end_date, seconds: a.seconds_per_loop })),
    changeFrom,
    next,
    vehicles: loads,
    loopSeconds,
  });
  if (!plan.ok) {
    throw conflict(
      "insufficient_capacity",
      `Im gewünschten Zeitraum sind nur ${plan.available} Fahrzeuge mit ausreichend freier Zeit verfügbar.`,
      { available: plan.available, requested: next?.vehicleCount },
    );
  }
  await tx`DELETE FROM allocations WHERE campaign_id = ${campaignId}`;
  if (plan.allocations.length > 0) {
    const rows = plan.allocations.map((a) => ({
      campaign_id: campaignId,
      vehicle_id: a.vehicleId,
      start_date: a.from,
      end_date: a.to,
      seconds_per_loop: a.seconds,
    }));
    await tx`INSERT INTO allocations ${tx(rows, "campaign_id", "vehicle_id", "start_date", "end_date", "seconds_per_loop")}`;
  }
  return [...new Set([...current.map((a) => a.vehicle_id), ...plan.allocations.map((a) => a.vehicleId)])];
}

async function vehiclesOfCampaign(db: Db, campaignId: string): Promise<string[]> {
  const rows = await db<{ vehicle_id: string }[]>`SELECT DISTINCT vehicle_id FROM allocations WHERE campaign_id = ${campaignId}`;
  return rows.map((r) => r.vehicle_id);
}

export interface CampaignInput {
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  vehicleCount: number;
  secondsPerLoop: number;
}

export async function createCampaign(
  ctx: AppContext,
  actor: Actor,
  input: CampaignInput & { customerId?: string; book?: boolean },
): Promise<CampaignRow> {
  const customerId = actor.role === "customer" ? actor.customerId : input.customerId;
  if (!customerId) throw badRequest("customer_required", "Kunde fehlt.");
  const settings = await loadSettings(ctx.sql);
  const today = await todayOf(ctx);
  const params = { from: input.startDate, to: input.endDate, seconds: input.secondsPerLoop, vehicleCount: input.vehicleCount };
  const issues = validateBookingParams(params, bookingRules(settings), today);
  if (issues.length) throw issuesToError(issues);

  return ctx.sql.begin(async (tx) => {
    const [customer] = await tx<{ status: string }[]>`SELECT status FROM customers WHERE id = ${customerId}`;
    if (!customer) throw notFound("Kunde nicht gefunden.");
    if (customer.status !== "active") throw forbidden("Kundenkonto gesperrt.");
    const [c] = await tx<CampaignRow[]>`
      INSERT INTO campaigns (customer_id, name, start_date, end_date, vehicle_count, seconds_per_loop, created_by)
      VALUES (${customerId}, ${input.name}, ${input.startDate}, ${input.endDate}, ${input.vehicleCount}, ${input.secondsPerLoop}, ${actor.userId})
      RETURNING *
    `;
    await audit(tx, actor.userId, "campaign.create", "campaign", c!.id, { ...input });
    if (!input.book) return c!;
    return bookInTx(tx, ctx, actor, c!, settings.loopSeconds, today);
  });
}

async function bookInTx(tx: Db, ctx: AppContext, actor: Actor, c: CampaignRow, loopSeconds: number, today: IsoDate) {
  const params = { from: c.start_date, to: c.end_date, seconds: c.seconds_per_loop, vehicleCount: c.vehicle_count };
  const vehicles = await reallocate(tx, c.id, params, today, loopSeconds, ctx.now());
  const [booked] = await tx<CampaignRow[]>`
    UPDATE campaigns SET status = 'booked', booked_at = now() WHERE id = ${c.id} RETURNING *
  `;
  await audit(tx, actor.userId, "campaign.book", "campaign", c.id, { vehicles: vehicles.length });
  await requestPlaylistRebuild(tx, vehicles);
  return booked!;
}

/** Entwurf verbindlich buchen. */
export async function bookCampaign(ctx: AppContext, actor: Actor, id: string): Promise<CampaignRow> {
  const settings = await loadSettings(ctx.sql);
  const today = await todayOf(ctx);
  return ctx.sql.begin(async (tx) => {
    const c = await getCampaign(tx, actor, id, { forUpdate: true });
    if (c.status !== "draft") throw conflict("invalid_status", "Nur Entwürfe können gebucht werden.");
    const params = { from: c.start_date, to: c.end_date, seconds: c.seconds_per_loop, vehicleCount: c.vehicle_count };
    const issues = validateBookingParams(params, bookingRules(settings), today);
    if (issues.length) throw issuesToError(issues);
    return bookInTx(tx, ctx, actor, c, settings.loopSeconds, today);
  });
}

export async function updateCampaign(
  ctx: AppContext,
  actor: Actor,
  id: string,
  patch: Partial<CampaignInput>,
): Promise<CampaignRow> {
  const settings = await loadSettings(ctx.sql);
  const today = await todayOf(ctx);
  return ctx.sql.begin(async (tx) => {
    const c = await getCampaign(tx, actor, id, { forUpdate: true });
    const next = {
      name: patch.name ?? c.name,
      from: patch.startDate ?? c.start_date,
      to: patch.endDate ?? c.end_date,
      seconds: patch.secondsPerLoop ?? c.seconds_per_loop,
      vehicleCount: patch.vehicleCount ?? c.vehicle_count,
    };
    const bookingChanged =
      next.from !== c.start_date ||
      next.to !== c.end_date ||
      next.seconds !== c.seconds_per_loop ||
      next.vehicleCount !== c.vehicle_count;
    const phase = campaignPhase(c, today);

    if (bookingChanged) {
      if (phase === "completed" || phase === "cancelled") {
        throw conflict("not_editable", "Beendete Kampagnen können nicht mehr geändert werden.");
      }
      const started = c.status !== "draft" && c.start_date <= today;
      if (started && next.from !== c.start_date) {
        throw badRequest("invalid_booking", "Der Start einer laufenden Kampagne kann nicht geändert werden.");
      }
      if (started && next.to < today) {
        throw badRequest("invalid_booking", "Das Ende darf nicht vor heute liegen.");
      }
      const issues = validateBookingParams(next, bookingRules(settings), started ? null : today);
      if (issues.length) throw issuesToError(issues);
    }

    const [updated] = await tx<CampaignRow[]>`
      UPDATE campaigns SET name = ${next.name}, start_date = ${next.from}, end_date = ${next.to},
        seconds_per_loop = ${next.seconds}, vehicle_count = ${next.vehicleCount}
      WHERE id = ${id} RETURNING *
    `;
    if (bookingChanged && c.status !== "draft") {
      const vehicles = await reallocate(tx, id, next, today, settings.loopSeconds, ctx.now());
      await requestPlaylistRebuild(tx, vehicles);
    }
    await audit(tx, actor.userId, "campaign.update", "campaign", id, { ...patch });
    return updated!;
  });
}

export async function pauseCampaign(ctx: AppContext, actor: Actor, id: string): Promise<CampaignRow> {
  return setRunState(ctx, actor, id, "paused");
}

export async function resumeCampaign(ctx: AppContext, actor: Actor, id: string): Promise<CampaignRow> {
  return setRunState(ctx, actor, id, "booked");
}

async function setRunState(ctx: AppContext, actor: Actor, id: string, target: "paused" | "booked") {
  const today = await todayOf(ctx);
  return ctx.sql.begin(async (tx) => {
    const c = await getCampaign(tx, actor, id, { forUpdate: true });
    const phase = campaignPhase(c, today);
    const from = target === "paused" ? "booked" : "paused";
    if (c.status !== from || phase === "completed") {
      throw conflict(
        "invalid_status",
        target === "paused"
          ? "Nur gebuchte, laufende Kampagnen können pausiert werden."
          : "Nur pausierte Kampagnen können fortgesetzt werden.",
      );
    }
    // Kapazität bleibt während der Pause reserviert.
    const [updated] = await tx<CampaignRow[]>`UPDATE campaigns SET status = ${target} WHERE id = ${id} RETURNING *`;
    await audit(tx, actor.userId, target === "paused" ? "campaign.pause" : "campaign.resume", "campaign", id);
    await requestPlaylistRebuild(tx, await vehiclesOfCampaign(tx, id));
    return updated!;
  });
}

/**
 * Beenden: Vor dem Start = stornieren (Kapazität wird frei).
 * Laufend = sofort stoppen; ab morgen wird die Kapazität frei.
 */
export async function endCampaign(ctx: AppContext, actor: Actor, id: string): Promise<CampaignRow> {
  const settings = await loadSettings(ctx.sql);
  const today = await todayOf(ctx);
  return ctx.sql.begin(async (tx) => {
    const c = await getCampaign(tx, actor, id, { forUpdate: true });
    if (c.status !== "booked" && c.status !== "paused") {
      throw conflict("invalid_status", "Nur gebuchte oder pausierte Kampagnen können beendet werden.");
    }
    if (campaignPhase(c, today) === "completed") throw conflict("invalid_status", "Kampagne ist bereits abgelaufen.");
    let updated: CampaignRow;
    let vehicles: string[];
    if (c.start_date > today) {
      vehicles = await reallocate(tx, id, null, c.start_date, settings.loopSeconds, ctx.now());
      updated = one(
        await tx<CampaignRow[]>`
        UPDATE campaigns SET status = 'cancelled', ended_at = now() WHERE id = ${id} RETURNING *
      `,
      );
    } else {
      vehicles = await reallocate(tx, id, null, addDays(today, 1), settings.loopSeconds, ctx.now());
      updated = one(
        await tx<CampaignRow[]>`
        UPDATE campaigns SET status = 'ended', ended_at = now(), end_date = ${today} WHERE id = ${id} RETURNING *
      `,
      );
    }
    await audit(tx, actor.userId, "campaign.end", "campaign", id, { status: updated.status });
    await requestPlaylistRebuild(tx, vehicles);
    return updated;
  });
}

export async function deleteDraft(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    const c = await getCampaign(tx, actor, id, { forUpdate: true });
    if (c.status !== "draft") throw conflict("invalid_status", "Nur Entwürfe können gelöscht werden.");
    await tx`DELETE FROM campaigns WHERE id = ${id}`;
    await audit(tx, actor.userId, "campaign.delete", "campaign", id);
  });
}

export async function listCampaigns(
  db: Db,
  actor: Actor,
  filter: { customerId?: string; status?: CampaignStatus } = {},
): Promise<(CampaignRow & { allocated_vehicles: number; customer_name: string })[]> {
  const customerId = actor.role === "customer" ? actor.customerId : (filter.customerId ?? null);
  return db`
    SELECT c.*, cu.name AS customer_name,
      (SELECT count(DISTINCT a.vehicle_id)::int FROM allocations a WHERE a.campaign_id = c.id) AS allocated_vehicles
    FROM campaigns c
    JOIN customers cu ON cu.id = c.customer_id
    WHERE (${customerId}::uuid IS NULL OR c.customer_id = ${customerId}::uuid)
      AND (${filter.status ?? null}::text IS NULL OR c.status = ${filter.status ?? null}::text)
    ORDER BY c.created_at DESC
  `;
}
