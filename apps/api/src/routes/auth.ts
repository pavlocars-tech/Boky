import { z } from "zod";
import type { App } from "../app";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { audit } from "../lib/audit";
import { createSession, destroySession, requireUser, revokeUserSessions } from "../lib/auth";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto";
import { AppError, badRequest } from "../lib/errors";

const email = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());
export const password = z.string().min(10, "Mindestens 10 Zeichen.").max(200);
const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

type TokenPurpose = "verify_email" | "password_reset" | "invite";

export async function createUserToken(db: Db, userId: string, purpose: TokenPurpose, hours: number, now: Date): Promise<string> {
  const token = randomToken();
  await db`DELETE FROM user_tokens WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`;
  await db`
    INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
    VALUES (${userId}, ${purpose}, ${sha256(token)}, ${new Date(now.getTime() + hours * 3_600_000)})
  `;
  return token;
}

/** Löst ein Einmal-Token ein; gibt die Benutzer-ID zurück. */
async function consumeUserToken(db: Db, token: string, purpose: TokenPurpose, now: Date): Promise<string> {
  const [row] = await db<{ user_id: string }[]>`
    UPDATE user_tokens SET used_at = ${now}
    WHERE token_hash = ${sha256(token)} AND purpose = ${purpose} AND used_at IS NULL AND expires_at > ${now}
    RETURNING user_id
  `;
  if (!row) throw badRequest("invalid_token", "Der Link ist ungültig oder abgelaufen.");
  return row.user_id;
}

export function serializeUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  customerId: string | null;
  customerRole: string | null;
}) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, customerId: u.customerId, customerRole: u.customerRole };
}

export async function authRoutes(app: App, ctx: AppContext) {
  const link = (path: string, token: string) => `${ctx.config.WEB_URL}${path}?token=${encodeURIComponent(token)}`;

  app.post(
    "/register",
    {
      config: authLimit,
      schema: {
        tags: ["Anmeldung"],
        summary: "Kunde registriert sich selbst (Firma + Inhaber-Konto)",
        body: z.object({
          companyName: z.string().trim().min(2).max(200),
          name: z.string().trim().min(2).max(200),
          email,
          password,
          address: z.string().max(500).optional(),
          vatId: z.string().max(50).optional(),
          phone: z.string().max(50).optional(),
          acceptTerms: z.literal(true),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const [existing] = await ctx.sql`SELECT id FROM users WHERE email = ${b.email}`;
      if (existing) {
        // Keine Auskunft, ob ein Konto existiert – stattdessen Hinweis per E-Mail.
        await ctx.mailer.send({
          to: b.email,
          subject: "TaxiAds: Konto bereits vorhanden",
          text: `Für diese E-Mail-Adresse gibt es bereits ein TaxiAds-Konto. Passwort vergessen? ${ctx.config.WEB_URL}/passwort-vergessen`,
        });
        return reply.status(201).send({ message: "Bitte bestätigen Sie Ihre E-Mail-Adresse über den zugesandten Link." });
      }
      const passwordHash = await hashPassword(b.password);
      const token = await ctx.sql.begin(async (tx) => {
        const [customer] = await tx<{ id: string }[]>`
          INSERT INTO customers (name, address, vat_id, phone, contact_email)
          VALUES (${b.companyName}, ${b.address ?? null}, ${b.vatId ?? null}, ${b.phone ?? null}, ${b.email})
          RETURNING id
        `;
        const [user] = await tx<{ id: string }[]>`
          INSERT INTO users (email, password_hash, name, role, customer_id, customer_role)
          VALUES (${b.email}, ${passwordHash}, ${b.name}, 'customer', ${customer!.id}, 'owner')
          RETURNING id
        `;
        await audit(tx, user!.id, "customer.register", "customer", customer!.id);
        return createUserToken(tx, user!.id, "verify_email", 48, ctx.now());
      });
      await ctx.mailer.send({
        to: b.email,
        subject: "TaxiAds: Bitte E-Mail-Adresse bestätigen",
        text: `Willkommen bei TaxiAds!\n\nBitte bestätigen Sie Ihre E-Mail-Adresse:\n${link("/email-bestaetigen", token)}\n\nDer Link ist 48 Stunden gültig.`,
      });
      return reply.status(201).send({ message: "Bitte bestätigen Sie Ihre E-Mail-Adresse über den zugesandten Link." });
    },
  );

  app.post(
    "/verify-email",
    { config: authLimit, schema: { tags: ["Anmeldung"], body: z.object({ token: z.string().min(10) }) } },
    async (req) => {
      const userId = await consumeUserToken(ctx.sql, req.body.token, "verify_email", ctx.now());
      await ctx.sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId} AND email_verified_at IS NULL`;
      return { ok: true };
    },
  );

  app.post(
    "/resend-verification",
    { config: authLimit, schema: { tags: ["Anmeldung"], body: z.object({ email }) } },
    async (req) => {
      const [user] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${req.body.email} AND email_verified_at IS NULL AND status = 'active'
      `;
      if (user) {
        const token = await createUserToken(ctx.sql, user.id, "verify_email", 48, ctx.now());
        await ctx.mailer.send({
          to: req.body.email,
          subject: "TaxiAds: Bitte E-Mail-Adresse bestätigen",
          text: `Bitte bestätigen Sie Ihre E-Mail-Adresse:\n${link("/email-bestaetigen", token)}`,
        });
      }
      return { ok: true };
    },
  );

  app.post(
    "/login",
    { config: authLimit, schema: { tags: ["Anmeldung"], body: z.object({ email, password: z.string().max(200) }) } },
    async (req, reply) => {
      const [u] = await ctx.sql<
        {
          id: string;
          email: string;
          name: string;
          role: string;
          customer_id: string | null;
          customer_role: string | null;
          password_hash: string | null;
          status: string;
          email_verified_at: Date | null;
          customer_status: string | null;
        }[]
      >`
        SELECT u.*, c.status AS customer_status FROM users u LEFT JOIN customers c ON c.id = u.customer_id
        WHERE u.email = ${req.body.email}
      `;
      const ok = u?.password_hash ? await verifyPassword(u.password_hash, req.body.password) : false;
      if (!u || !ok || u.status !== "active") {
        throw new AppError(401, "invalid_credentials", "E-Mail oder Passwort falsch.");
      }
      if (u.role === "customer" && !u.email_verified_at) {
        throw new AppError(403, "email_not_verified", "Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.");
      }
      if (u.customer_status === "blocked") throw new AppError(403, "customer_blocked", "Ihr Kundenkonto ist gesperrt.");
      await createSession(ctx, reply, req, u.id);
      return {
        user: serializeUser({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          customerId: u.customer_id,
          customerRole: u.customer_role,
        }),
      };
    },
  );

  app.post("/logout", { schema: { tags: ["Anmeldung"] } }, async (req, reply) => {
    await destroySession(ctx, req, reply);
    return { ok: true };
  });

  app.get("/me", { schema: { tags: ["Anmeldung"] } }, async (req) => {
    return { user: serializeUser(requireUser(req)) };
  });

  app.post(
    "/password-reset/request",
    { config: authLimit, schema: { tags: ["Anmeldung"], body: z.object({ email }) } },
    async (req) => {
      const [user] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${req.body.email} AND status = 'active'
      `;
      if (user) {
        const token = await createUserToken(ctx.sql, user.id, "password_reset", 2, ctx.now());
        await ctx.mailer.send({
          to: req.body.email,
          subject: "TaxiAds: Passwort zurücksetzen",
          text: `Über diesen Link können Sie ein neues Passwort festlegen (2 Stunden gültig):\n${link("/passwort-zuruecksetzen", token)}`,
        });
      }
      return { ok: true };
    },
  );

  app.post(
    "/password-reset/confirm",
    { config: authLimit, schema: { tags: ["Anmeldung"], body: z.object({ token: z.string().min(10), password }) } },
    async (req) => {
      const hash = await hashPassword(req.body.password);
      await ctx.sql.begin(async (tx) => {
        const userId = await consumeUserToken(tx, req.body.token, "password_reset", ctx.now());
        // Wer den Link aus der E-Mail nutzt, hat die Adresse damit auch bestätigt.
        await tx`UPDATE users SET password_hash = ${hash}, email_verified_at = coalesce(email_verified_at, now()) WHERE id = ${userId}`;
        await revokeUserSessions(tx, userId);
      });
      return { ok: true };
    },
  );

  app.post(
    "/invitation/accept",
    {
      config: authLimit,
      schema: {
        tags: ["Anmeldung"],
        summary: "Einladung als Mitarbeiter eines Kunden annehmen",
        body: z.object({ token: z.string().min(10), name: z.string().trim().min(2).max(200).optional(), password }),
      },
    },
    async (req, reply) => {
      const hash = await hashPassword(req.body.password);
      const userId = await ctx.sql.begin(async (tx) => {
        const id = await consumeUserToken(tx, req.body.token, "invite", ctx.now());
        await tx`
          UPDATE users SET password_hash = ${hash}, status = 'active', email_verified_at = now(),
            name = coalesce(${req.body.name ?? null}, name)
          WHERE id = ${id} AND status = 'invited'
        `;
        return id;
      });
      await createSession(ctx, reply, req, userId);
      return { ok: true };
    },
  );

  app.post(
    "/change-password",
    { schema: { tags: ["Anmeldung"], body: z.object({ currentPassword: z.string().max(200), newPassword: password }) } },
    async (req) => {
      const user = requireUser(req);
      const [row] = await ctx.sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${user.id}`;
      if (!row || !(await verifyPassword(row.password_hash, req.body.currentPassword))) {
        throw new AppError(400, "invalid_credentials", "Aktuelles Passwort ist falsch.");
      }
      const hash = await hashPassword(req.body.newPassword);
      await ctx.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${user.id}`;
      await ctx.sql`DELETE FROM sessions WHERE user_id = ${user.id} AND token_hash <> ${sha256(req.cookies.taxiads_session ?? "")}`;
      return { ok: true };
    },
  );
}
