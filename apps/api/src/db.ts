import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Datenbankverbindung oder laufende Transaktion. */
export type Db = Sql | Tx;

/** Erste Zeile eines Ergebnisses; Fehler, wenn keine vorhanden ist. */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Abfrage lieferte keine Zeile");
  return row;
}

export function createDb(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    onnotice: () => {},
    types: {
      // `date` als "YYYY-MM-DD"-String statt Date-Objekt (vermeidet Zeitzonenfehler).
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    transform: { undefined: null },
  });
}

/** Sucht den Ordner `migrations` ausgehend vom Quell- bzw. Build-Verzeichnis nach oben. */
function findMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "migrations");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("Ordner 'migrations' nicht gefunden");
}

export async function migrate(
  sql: Sql,
  dir = process.env.MIGRATIONS_DIR ?? findMigrationsDir(),
  log: (m: string) => void = () => {},
): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    log(`Migration angewendet: ${file}`);
    done.push(file);
  }
  return done;
}
