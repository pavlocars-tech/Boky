import { localDate, localMinutes } from "@taxiads/shared";
import type { AppContext } from "../context";
import { ensureUpcomingPartitions } from "../lib/partitions";
import { loadSettings } from "../lib/settings";
import { enqueueAllPlaylists } from "./playlists";

const HEARTBEAT_RETENTION_DAYS = 30;

/**
 * Löschfristen (DSGVO): GPS-Rohdaten älter als `gpsRawRetentionDays` werden gelöscht.
 * Ganze Monatspartitionen werden verworfen (schnell), der Rest zeilenweise gelöscht.
 */
export async function applyRetention(ctx: AppContext): Promise<{ gpsDeleted: number; partitionsDropped: string[] }> {
  const settings = await loadSettings(ctx.sql, { fresh: true });
  const cutoff = new Date(ctx.now().getTime() - settings.gpsRawRetentionDays * 86_400_000);
  const heartbeatCutoff = new Date(ctx.now().getTime() - HEARTBEAT_RETENTION_DAYS * 86_400_000);
  const dropped: string[] = [];
  for (const [table, limit] of [
    ["gps_points", cutoff],
    ["device_heartbeats", heartbeatCutoff],
  ] as const) {
    const parts = await ctx.sql<{ name: string; upper: string }[]>`
      SELECT c.relname AS name,
        (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1] AS upper
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ${table}
    `;
    for (const p of parts) {
      if (p.upper && new Date(p.upper) <= limit) {
        await ctx.sql.unsafe(`DROP TABLE IF EXISTS "${p.name.replace(/"/g, "")}"`);
        dropped.push(p.name);
      }
    }
  }
  const gps = await ctx.sql`DELETE FROM gps_points WHERE recorded_at < ${cutoff}`;
  await ctx.sql`DELETE FROM device_heartbeats WHERE received_at < ${heartbeatCutoff}`;
  await ctx.sql`DELETE FROM sessions WHERE expires_at < ${ctx.now()}`;
  await ctx.sql`DELETE FROM user_tokens WHERE expires_at < ${new Date(ctx.now().getTime() - 7 * 86_400_000)}`;
  await ctx.sql`UPDATE device_pairings SET status = 'expired' WHERE status = 'pending' AND expires_at < ${ctx.now()}`;
  return { gpsDeleted: gps.count, partitionsDropped: dropped };
}

interface DailyTask {
  name: string;
  /** Frühestens ab dieser lokalen Uhrzeit (Minuten seit Mitternacht). */
  afterMinutes: number;
  run: (ctx: AppContext) => Promise<unknown>;
}

export const DAILY_TASKS: DailyTask[] = [
  // Kurz nach Mitternacht: neues 7-Tage-Fenster für alle Playlists.
  { name: "playlists", afterMinutes: 5, run: (ctx) => enqueueAllPlaylists(ctx.sql) },
  { name: "partitions", afterMinutes: 0, run: (ctx) => ensureUpcomingPartitions(ctx.sql, ctx.now()) },
  { name: "retention", afterMinutes: 3 * 60, run: applyRetention },
];

/** Führt fällige Tagesaufgaben aus (je Aufgabe höchstens einmal pro lokalem Kalendertag). */
export async function runDailyTasks(ctx: AppContext): Promise<string[]> {
  const settings = await loadSettings(ctx.sql);
  const today = localDate(ctx.now(), settings.timezone);
  const minutes = localMinutes(ctx.now(), settings.timezone);
  const ran: string[] = [];
  for (const task of DAILY_TASKS) {
    if (minutes < task.afterMinutes) continue;
    const claimed = await ctx.sql`
      INSERT INTO scheduled_runs (name, last_run) VALUES (${task.name}, ${today})
      ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run WHERE scheduled_runs.last_run < EXCLUDED.last_run
      RETURNING name
    `;
    if (claimed.length === 0) continue;
    try {
      await task.run(ctx);
      ran.push(task.name);
    } catch (err) {
      ctx.log.error({ err }, `Tagesaufgabe ${task.name} fehlgeschlagen`);
      await ctx.sql`UPDATE scheduled_runs SET last_run = last_run - 1 WHERE name = ${task.name}`;
    }
  }
  return ran;
}
