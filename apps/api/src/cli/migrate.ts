import { loadConfig } from "../config";
import { createDb, migrate } from "../db";
import { ensureUpcomingPartitions } from "../lib/partitions";

const sql = createDb(loadConfig().DATABASE_URL, 1);
const done = await migrate(sql, undefined, (m) => console.log(m));
await ensureUpcomingPartitions(sql, new Date());
console.log(done.length ? `${done.length} Migration(en) angewendet.` : "Datenbank ist aktuell.");
await sql.end();
