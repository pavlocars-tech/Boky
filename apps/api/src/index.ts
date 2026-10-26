import { buildApp } from "./app";
import { createContext } from "./bootstrap";
import { migrate } from "./db";
import { ensureUpcomingPartitions } from "./lib/partitions";
import { S3Storage } from "./lib/storage";

const ctx = createContext();
await migrate(ctx.sql, undefined, (m) => console.log(m));
await ensureUpcomingPartitions(ctx.sql, ctx.now());
if (ctx.config.S3_CREATE_BUCKET && ctx.storage instanceof S3Storage) await ctx.storage.ensureBucket();
const app = await buildApp(ctx);
await app.listen({ host: ctx.config.HOST, port: ctx.config.PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await ctx.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
