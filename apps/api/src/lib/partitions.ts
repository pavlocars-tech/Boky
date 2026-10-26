import type { Db } from "../db";

export type PartitionedTable = "playback_events" | "gps_points" | "device_heartbeats";

const known = new Set<string>();

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Stellt sicher, dass für alle Monate der Zeitpunkte eine Partition existiert. */
export async function ensurePartitions(db: Db, table: PartitionedTable, instants: Date[]): Promise<void> {
  const months = new Set(instants.map(monthKey));
  for (const month of months) {
    const key = `${table}:${month}`;
    if (known.has(key)) continue;
    await db`SELECT ensure_month_partition(${table}, ${month}::date)`;
    known.add(key);
  }
}

/** Legt Partitionen für den aktuellen und die nächsten Monate an. */
export async function ensureUpcomingPartitions(db: Db, now: Date, monthsAhead = 3): Promise<void> {
  const dates: Date[] = [];
  for (let i = -1; i <= monthsAhead; i++) {
    dates.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)));
  }
  for (const table of ["playback_events", "gps_points", "device_heartbeats"] as const) {
    await ensurePartitions(db, table, dates);
  }
}

export function resetPartitionCache(): void {
  known.clear();
}
