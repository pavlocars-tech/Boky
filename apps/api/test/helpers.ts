import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import { buildApp } from "../src/app";
import { createContext } from "../src/bootstrap";
import { loadConfig } from "../src/config";
import type { AppContext } from "../src/context";
import { createDb } from "../src/db";
import { hashPassword } from "../src/lib/crypto";
import { MemoryMailer } from "../src/lib/mailer";
import { resetPartitionCache } from "../src/lib/partitions";
import { invalidateSettingsCache } from "../src/lib/settings";
import { DEVICE_ASSERTION_AUDIENCE } from "../src/services/devices";
import { TEST_DATABASE_URL } from "./global-setup";

export interface TestEnv {
  ctx: AppContext;
  app: FastifyInstance;
  mailer: MemoryMailer;
  clock: { now: Date };
  close: () => Promise<void>;
}

/** 2. November 2026, 11:00 Uhr in Wien */
export const DEFAULT_NOW = new Date("2026-11-02T10:00:00Z");

export async function createTestEnv(): Promise<TestEnv> {
  const mailer = new MemoryMailer();
  const clock = { now: DEFAULT_NOW };
  const storageDir = mkdtempSync(path.join(tmpdir(), "taxiads-test-storage-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    LOCAL_STORAGE_DIR: storageDir,
    PUBLIC_API_URL: "http://localhost",
    RATE_LIMIT_ENABLED: "false",
    CORS_ORIGINS: "http://localhost:3001",
  });
  const ctx = createContext({
    config,
    sql: createDb(TEST_DATABASE_URL, 10),
    mailer,
    now: () => clock.now,
    log: { info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error(...a) } as AppContext["log"],
  });
  await resetDb(ctx);
  const app = await buildApp(ctx, { logger: false });
  return {
    ctx,
    app,
    mailer,
    clock,
    close: async () => {
      await app.close();
      await ctx.sql.end();
    },
  };
}

export async function resetDb(ctx: AppContext) {
  const tables = await ctx.sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys')
      AND tablename NOT LIKE '%\\_20____' ESCAPE '\\'
  `;
  await ctx.sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  invalidateSettingsCache();
  resetPartitionCache();
}

export type Session = { cookie: string };

export function cookieOf(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name === "taxiads_session");
  if (!c) throw new Error(`Kein Session-Cookie: ${res.statusCode} ${res.body}`);
  return `taxiads_session=${c.value}`;
}

export async function api(
  env: TestEnv,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  opts: { session?: Session; body?: unknown; token?: string; query?: Record<string, string> } = {},
) {
  const res = await env.app.inject({
    method,
    url,
    query: opts.query,
    payload: opts.body as never,
    headers: {
      ...(opts.session ? { cookie: opts.session.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
  });
  let json: any = undefined;
  try {
    json = res.json();
  } catch {
    // keine JSON-Antwort
  }
  return { status: res.statusCode, json, res };
}

export async function createAdmin(env: TestEnv, email = "admin@taxiads.test", password = "admin-passwort-123"): Promise<Session> {
  const hash = await hashPassword(password);
  await env.ctx.sql`
    INSERT INTO users (email, password_hash, name, role, email_verified_at) VALUES (${email}, ${hash}, 'Admin', 'admin', now())
  `;
  return login(env, email, password);
}

export async function login(env: TestEnv, email: string, password: string): Promise<Session> {
  const res = await env.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  return { cookie: cookieOf(res) };
}

/** Registriert einen Kunden, bestätigt die E-Mail und meldet an. */
export async function createCustomer(
  env: TestEnv,
  company = "Bäckerei Huber",
  email = `kunde-${randomUUID().slice(0, 8)}@example.com`,
) {
  const password = "kunden-passwort-123";
  const reg = await api(env, "POST", "/auth/register", {
    body: { companyName: company, name: "Maria Huber", email, password, acceptTerms: true },
  });
  if (reg.status !== 201) throw new Error(`Registrierung fehlgeschlagen: ${reg.res.body}`);
  const token = tokenFromMail(env.mailer.last(email)!.text);
  await api(env, "POST", "/auth/verify-email", { body: { token } });
  const session = await login(env, email, password);
  const me = await api(env, "GET", "/auth/me", { session });
  return { session, email, password, customerId: me.json.user.customerId as string, userId: me.json.user.id as string };
}

export function tokenFromMail(text: string): string {
  const m = /token=([^\s&]+)/.exec(text);
  if (!m) throw new Error(`Kein Token in E-Mail: ${text}`);
  return decodeURIComponent(m[1]!);
}

export async function createVehicles(env: TestEnv, admin: Session, count: number, prefix = "W-TAXI"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const r = await api(env, "POST", "/admin/vehicles", {
      session: admin,
      body: { label: `${prefix}-${String(i).padStart(3, "0")}` },
    });
    if (r.status !== 201) throw new Error(r.res.body);
    ids.push(r.json.id);
  }
  return ids;
}

export interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  publicKeyB64: string;
  token: string;
}

export function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

export async function deviceAssertion(deviceId: string, privateKey: KeyObject, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(deviceId)
    .setAudience(DEVICE_ASSERTION_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .setJti(randomUUID())
    .sign(privateKey);
}

/** Kompletter Kopplungsablauf: Gerät -> Code -> Admin ordnet zu -> Gerät holt Token. */
export async function pairDevice(env: TestEnv, admin: Session, vehicleId: string, screenSlot?: number): Promise<TestDevice> {
  const { privateKey, publicKeyB64 } = deviceKeys();
  const start = await api(env, "POST", "/device/v1/pairing", {
    body: {
      publicKey: publicKeyB64,
      deviceInfo: { manufacturer: "samsung", model: "SM-X216B", androidVersion: "14", appVersion: "1.0.0" },
    },
  });
  if (start.status !== 201) throw new Error(start.res.body);
  const claim = await api(env, "POST", "/admin/devices/claim", {
    session: admin,
    body: { code: start.json.code, vehicleId, screenSlot },
  });
  if (claim.status !== 201) throw new Error(claim.res.body);
  const status = await api(env, "GET", `/device/v1/pairing/${start.json.pairingId}`);
  const deviceId = status.json.deviceId as string;
  const tok = await api(env, "POST", "/device/v1/token", {
    body: { assertion: await deviceAssertion(deviceId, privateKey, env.clock.now) },
  });
  if (tok.status !== 200) throw new Error(tok.res.body);
  return { deviceId, privateKey, publicKeyB64, token: tok.json.accessToken };
}
