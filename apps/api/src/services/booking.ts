import { bookingRules, localDate, availableVehicles, type IsoDate, type VehicleLoad } from "@taxiads/shared";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { loadSettings } from "../lib/settings";

/** Sperre für alle Buchungsvorgänge: verhindert, dass zwei Buchungen dieselbe Zeit verkaufen. */
export async function lockBookings(tx: Db): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('taxiads:booking'))`;
}

/**
 * Lädt alle buchbaren Fahrzeuge mit ihren Zuteilungen im Zeitraum.
 * `excludeCampaignId`: Zuteilungen dieser Kampagne ignorieren (bei Änderungen).
 */
export async function loadVehicleLoads(
  db: Db,
  from: IsoDate,
  to: IsoDate,
  excludeCampaignId: string | null = null,
  now = new Date(),
): Promise<VehicleLoad[]> {
  const vehicles = await db<{ id: string; recently_online: boolean }[]>`
    SELECT v.id,
      EXISTS (
        SELECT 1 FROM devices d
        WHERE d.vehicle_id = v.id AND d.status = 'active' AND d.last_seen_at > ${new Date(now.getTime() - 86_400_000)}
      ) AS recently_online
    FROM vehicles v
    WHERE v.active
    ORDER BY v.id
  `;
  const allocations = await db<{ vehicle_id: string; start_date: string; end_date: string; seconds_per_loop: number }[]>`
    SELECT a.vehicle_id, a.start_date, a.end_date, a.seconds_per_loop
    FROM allocations a
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.period && daterange(${from}::date, ${to}::date, '[]')
      AND c.status IN ('booked', 'paused', 'ended')
      AND a.campaign_id IS DISTINCT FROM ${excludeCampaignId}::uuid
  `;
  const byVehicle = new Map<string, VehicleLoad>();
  for (const v of vehicles) {
    byVehicle.set(v.id, { vehicleId: v.id, allocations: [], score: v.recently_online ? 1 : 0 });
  }
  for (const a of allocations) {
    byVehicle.get(a.vehicle_id)?.allocations.push({ from: a.start_date, to: a.end_date, seconds: a.seconds_per_loop });
  }
  return [...byVehicle.values()];
}

export interface AvailabilityResult {
  available: number;
  totalVehicles: number;
  loopSeconds: number;
}

export async function checkAvailability(
  ctx: AppContext,
  params: { from: IsoDate; to: IsoDate; seconds: number; excludeCampaignId?: string | null },
): Promise<AvailabilityResult> {
  const settings = await loadSettings(ctx.sql);
  const loads = await loadVehicleLoads(ctx.sql, params.from, params.to, params.excludeCampaignId ?? null, ctx.now());
  return {
    available: availableVehicles(loads, params.from, params.to, params.seconds, settings.loopSeconds).length,
    totalVehicles: loads.length,
    loopSeconds: settings.loopSeconds,
  };
}

export async function today(ctx: AppContext): Promise<IsoDate> {
  const settings = await loadSettings(ctx.sql);
  return localDate(ctx.now(), settings.timezone);
}

export async function currentBookingRules(ctx: AppContext) {
  return bookingRules(await loadSettings(ctx.sql));
}
