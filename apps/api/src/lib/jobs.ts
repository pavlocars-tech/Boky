import type { Db, Sql } from "../db";

export interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  /** Gleicher Schlüssel = nur ein offener Job; läuft er gerade, wird er danach erneut ausgeführt. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(db: Db, type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<void> {
  const runAt = opts.runAt ?? new Date();
  await db`
    INSERT INTO jobs (type, payload, dedupe_key, run_at, max_attempts)
    VALUES (${type}, ${db.json(payload as never)}, ${opts.dedupeKey ?? null}, ${runAt}, ${opts.maxAttempts ?? 5})
    ON CONFLICT (dedupe_key) DO UPDATE SET
      requeue = jobs.locked_until IS NOT NULL AND jobs.locked_until > now(),
      run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
      attempts = CASE WHEN jobs.attempts >= jobs.max_attempts THEN 0 ELSE jobs.attempts END,
      payload = EXCLUDED.payload
  `;
}

export async function claimJobs(sql: Sql, limit: number, lockSeconds = 300): Promise<JobRow[]> {
  return sql<JobRow[]>`
    UPDATE jobs SET locked_until = now() + make_interval(secs => ${lockSeconds}), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs
      WHERE run_at <= now() AND attempts < max_attempts AND (locked_until IS NULL OR locked_until < now())
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, max_attempts
  `;
}

export async function completeJob(sql: Sql, id: string): Promise<void> {
  const [row] = await sql<{ requeue: boolean }[]>`
    DELETE FROM jobs WHERE id = ${id} AND NOT requeue RETURNING requeue
  `;
  if (!row) {
    await sql`UPDATE jobs SET requeue = false, locked_until = NULL, attempts = 0, run_at = now() WHERE id = ${id}`;
  }
}

export async function failJob(sql: Sql, job: JobRow, error: unknown): Promise<void> {
  const backoffSeconds = Math.min(3600, 10 * 2 ** (job.attempts - 1));
  await sql`
    UPDATE jobs SET locked_until = NULL, last_error = ${String(error instanceof Error ? (error.stack ?? error.message) : error)},
      run_at = now() + make_interval(secs => ${backoffSeconds})
    WHERE id = ${job.id}
  `;
}

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/** Arbeitet fällige Jobs ab; gibt die Anzahl erledigter Jobs zurück. */
export async function runDueJobs(sql: Sql, handlers: Record<string, JobHandler>, limit = 10): Promise<number> {
  const jobs = await claimJobs(sql, limit);
  for (const job of jobs) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`Kein Handler für Job-Typ ${job.type}`);
      await handler(job.payload);
      await completeJob(sql, job.id);
    } catch (err) {
      await failJob(sql, job, err);
    }
  }
  return jobs.length;
}
