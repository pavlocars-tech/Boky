import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import type { AppContext, SessionUser } from "../context";
import type { Db } from "../db";
import { randomToken, sha256 } from "./crypto";
import { forbidden, unauthorized } from "./errors";

export const SESSION_COOKIE = "taxiads_session";
const DEVICE_AUDIENCE = "taxiads-device";

export interface DeviceAuth {
  id: string;
  vehicleId: string | null;
  screenSlot: number | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    device?: DeviceAuth;
  }
}

// ---------------------------------------------------------------------------
// Sessions (Web)
// ---------------------------------------------------------------------------

export async function createSession(ctx: AppContext, reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = randomToken();
  const expires = new Date(ctx.now().getTime() + ctx.config.SESSION_TTL_DAYS * 86_400_000);
  await ctx.sql`
    INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
    VALUES (${sha256(token)}, ${userId}, ${expires}, ${req.ip}, ${req.headers["user-agent"] ?? null})
  `;
  await ctx.sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function destroySession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.sql`DELETE FROM sessions WHERE token_hash = ${sha256(token)}`;
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function revokeUserSessions(db: Db, userId: string): Promise<void> {
  await db`DELETE FROM sessions WHERE user_id = ${userId}`;
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "customer";
  customer_id: string | null;
  customer_role: "owner" | "member" | null;
};

export async function userFromSession(ctx: AppContext, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token) return undefined;
  const [row] = await ctx.sql<UserRow[]>`
    SELECT u.id, u.email, u.name, u.role, u.customer_id, u.customer_role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN customers c ON c.id = u.customer_id
    WHERE s.token_hash = ${sha256(token)}
      AND s.expires_at > ${ctx.now()}
      AND u.status = 'active'
      AND (c.id IS NULL OR c.status = 'active')
  `;
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    customerId: row.customer_id,
    customerRole: row.customer_role,
  };
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== "admin") throw forbidden();
  return user;
}

export function requireCustomer(req: FastifyRequest, { owner = false } = {}): SessionUser & { customerId: string } {
  const user = requireUser(req);
  if (user.role !== "customer" || !user.customerId) throw forbidden();
  if (owner && user.customerRole !== "owner") throw forbidden("Nur für Inhaber des Kundenkontos.");
  return user as SessionUser & { customerId: string };
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

function secretKey(ctx: AppContext): Uint8Array {
  return new TextEncoder().encode(ctx.config.APP_SECRET);
}

export async function issueDeviceToken(ctx: AppContext, deviceId: string): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = ctx.config.DEVICE_TOKEN_TTL_SECONDS;
  const now = Math.floor(ctx.now().getTime() / 1000);
  const token = await new SignJWT({ typ: "device" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(deviceId)
    .setAudience(DEVICE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(secretKey(ctx));
  return { token, expiresIn };
}

export async function authenticateDevice(ctx: AppContext, req: FastifyRequest): Promise<DeviceAuth> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("Gerätetoken fehlt.");
  let deviceId: string;
  try {
    const { payload } = await jwtVerify(header.slice(7), secretKey(ctx), {
      audience: DEVICE_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: ctx.now(),
    });
    if (payload.typ !== "device" || !payload.sub) throw new Error("typ");
    deviceId = payload.sub;
  } catch {
    throw unauthorized("Gerätetoken ungültig oder abgelaufen.");
  }
  const [device] = await ctx.sql<{ id: string; vehicle_id: string | null; screen_slot: number | null; status: string }[]>`
    SELECT id, vehicle_id, screen_slot, status FROM devices WHERE id = ${deviceId}
  `;
  if (!device || device.status !== "active") throw unauthorized("Gerät gesperrt oder unbekannt.");
  return { id: device.id, vehicleId: device.vehicle_id, screenSlot: device.screen_slot };
}
