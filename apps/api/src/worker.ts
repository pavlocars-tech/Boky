import { createContext } from "./bootstrap";
import { migrate } from "./db";
import { jobHandlers } from "./jobs";
import { runDueJobs } from "./lib/jobs";
import { runDailyTasks } from "./services/maintenance";

const ctx = createContext();
await migrate(ctx.sql, undefined, (m) => console.log(m));
const handlers = jobHandlers(ctx);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping = true));
let lastDaily = 0;
console.log("Worker gestartet");

while (!stopping) {
  try {
    if (Date.now() - lastDaily > 60_000) {
      lastDaily = Date.now();
      const ran = await runDailyTasks(ctx);
      if (ran.length) console.log(`Tagesaufgaben: ${ran.join(", ")}`);
    }
    const n = await runDueJobs(ctx.sql, handlers, 10);
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    console.error(err);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await ctx.sql.end({ timeout: 5 });
