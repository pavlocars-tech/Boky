import postgres from "postgres";
import { createDb, migrate } from "../src/db";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://taxiads:taxiads@localhost:5432/taxiads_test";

/** Legt vor allen Tests eine frische Testdatenbank an. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const sql = createDb(TEST_DATABASE_URL, 1);
  await migrate(sql);
  await sql.end();
}
