import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts", "src/cli/migrate.ts", "src/cli/seed.ts", "src/cli/create-admin.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Gemeinsamer Code wird mitgebündelt, npm-Pakete bleiben extern.
  noExternal: ["@taxiads/shared"],
});
