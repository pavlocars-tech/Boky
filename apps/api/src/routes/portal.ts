import { z } from "zod";
import type { App } from "../app";
import { actorOf, type AppContext } from "../context";
import { one } from "../db";
import { audit } from "../lib/audit";
import { requireCustomer } from "../lib/auth";
import { badRequest, conflict, notFound } from "../lib/errors";
import { loadSettings } from "../lib/settings";
import { checkAvailability, currentBookingRules, today } from "../services/booking";
import {
  bookCampaign,
  createCampaign,
  deleteDraft,
  endCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  serializeCampaign,
  updateCampaign,
} from "../services/campaigns";
import { completeUpload, listCreatives, requestCreativeUpload, serializeCreative, updateCreative } from "../services/media";
import { createUserToken } from "./auth";
import { availabilityBody, campaignBody, creativePatch, idParam, uploadBody } from "./schemas";

const tags = ["Kundenportal"];

export async function portalRoutes(app: App, ctx: AppContext) {
  // ---------------------------------------------------------------- Firma
  app.get("/company", { schema: { tags } }, async (req) => {
    const user = requireCustomer(req);
    const [c] = await ctx.sql`
      SELECT id, name, address, vat_id AS "vatId", phone, contact_email AS "contactEmail", status
      FROM customers WHERE id = ${user.customerId}
    `;
    return c;
  });

  app.patch(
    "/company",
    {
      schema: {
        tags,
        body: z.object({
          name: z.string().trim().min(2).max(200).optional(),
          address: z.string().max(500).nullable().optional(),
          vatId: z.string().max(50).nullable().optional(),
          phone: z.string().max(50).nullable().optional(),
          contactEmail: z.email().nullable().optional(),
        }),
      },
    },
    async (req) => {
      const user = requireCustomer(req, { owner: true });
      const b = req.body;
      const [c] = await ctx.sql`
        UPDATE customers SET
          name = coalesce(${b.name ?? null}, name),
          address = CASE WHEN ${b.address !== undefined} THEN ${b.address ?? null} ELSE address END,
          vat_id = CASE WHEN ${b.vatId !== undefined} THEN ${b.vatId ?? null} ELSE vat_id END,
          phone = CASE WHEN ${b.phone !== undefined} THEN ${b.phone ?? null} ELSE phone END,
          contact_email = CASE WHEN ${b.contactEmail !== undefined} THEN ${b.contactEmail ?? null} ELSE contact_email END
        WHERE id = ${user.customerId}
        RETURNING id, name, address, vat_id AS "vatId", phone, contact_email AS "contactEmail", status
      `;
      await audit(ctx.sql, user.id, "customer.update", "customer", user.customerId, { ...b });
      return c;
    },
  );

  // ---------------------------------------------------------------- Mitarbeiter
  app.get("/team", { schema: { tags } }, async (req) => {
    const user = requireCustomer(req);
    return ctx.sql`
      SELECT id, email, name, customer_role AS role, status, last_login_at AS "lastLoginAt", created_at AS "createdAt"
      FROM users WHERE customer_id = ${user.customerId} ORDER BY created_at
    `;
  });

  app.post(
    "/team/invitations",
    {
      schema: {
        tags,
        summary: "Mitarbeiter einladen (nur Inhaber)",
        body: z.object({
          email: z.email().transform((e) => e.trim().toLowerCase()),
          name: z.string().trim().min(2).max(200),
          role: z.enum(["owner", "member"]).default("member"),
        }),
      },
    },
    async (req, reply) => {
      const user = requireCustomer(req, { owner: true });
      const b = req.body;
      const [existing] = await ctx.sql`SELECT id FROM users WHERE email = ${b.email}`;
      if (existing) throw conflict("email_taken", "Für diese E-Mail-Adresse gibt es bereits ein Konto.");
      const { id, token } = await ctx.sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          INSERT INTO users (email, name, role, customer_id, customer_role, status)
          VALUES (${b.email}, ${b.name}, 'customer', ${user.customerId}, ${b.role}, 'invited')
          RETURNING id
        `;
        await audit(tx, user.id, "user.invite", "user", u!.id, { role: b.role });
        return { id: u!.id, token: await createUserToken(tx, u!.id, "invite", 24 * 7, ctx.now()) };
      });
      const [company] = await ctx.sql<{ name: string }[]>`SELECT name FROM customers WHERE id = ${user.customerId}`;
      await ctx.mailer.send({
        to: b.email,
        subject: `Einladung zu TaxiAds (${company!.name})`,
        text: `${user.name} hat Sie eingeladen, das TaxiAds-Kundenportal von ${company!.name} zu nutzen.\n\nKonto einrichten (7 Tage gültig):\n${ctx.config.WEB_URL}/einladung?token=${encodeURIComponent(token)}`,
      });
      return reply.status(201).send({ id });
    },
  );

  app.patch(
    "/team/:id",
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({ role: z.enum(["owner", "member"]).optional(), status: z.enum(["active", "disabled"]).optional() }),
      },
    },
    async (req) => {
      const user = requireCustomer(req, { owner: true });
      await ctx.sql.begin(async (tx) => {
        const [target] = await tx<{ id: string; status: string; customer_role: string }[]>`
          SELECT id, status, customer_role FROM users WHERE id = ${req.params.id} AND customer_id = ${user.customerId} FOR UPDATE
        `;
        if (!target) throw notFound("Benutzer nicht gefunden.");
        if (target.status === "invited" && req.body.status) throw badRequest("invited", "Einladung wurde noch nicht angenommen.");
        const role = req.body.role ?? target.customer_role;
        const status = req.body.status ?? target.status;
        if (target.customer_role === "owner" && (role !== "owner" || status !== "active")) {
          const { owners } = one(
            await tx<{ owners: number }[]>`
              SELECT count(*)::int AS owners FROM users
              WHERE customer_id = ${user.customerId} AND customer_role = 'owner' AND status = 'active' AND id <> ${target.id}
            `,
          );
          if (owners === 0) throw conflict("last_owner", "Es muss mindestens ein aktiver Inhaber bleiben.");
        }
        await tx`UPDATE users SET customer_role = ${role}, status = ${status} WHERE id = ${target.id}`;
        if (status === "disabled") await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
        await audit(tx, user.id, "user.update", "user", target.id, { ...req.body });
      });
      return { ok: true };
    },
  );

  app.delete("/team/:id", { schema: { tags, summary: "Offene Einladung zurückziehen", params: idParam } }, async (req) => {
    const user = requireCustomer(req, { owner: true });
    const rows = await ctx.sql`
      DELETE FROM users WHERE id = ${req.params.id} AND customer_id = ${user.customerId} AND status = 'invited' RETURNING id
    `;
    if (rows.length === 0) throw notFound("Offene Einladung nicht gefunden.");
    return { ok: true };
  });

  // ---------------------------------------------------------------- Buchungsregeln & Verfügbarkeit
  app.get("/booking-rules", { schema: { tags } }, async (req) => {
    requireCustomer(req);
    const settings = await loadSettings(ctx.sql);
    return {
      ...(await currentBookingRules(ctx)),
      today: await today(ctx),
      timezone: settings.timezone,
      maxImageUploadMb: settings.maxImageUploadMb,
      maxVideoUploadMb: settings.maxVideoUploadMb,
    };
  });

  app.post(
    "/availability",
    { schema: { tags, summary: "Wie viele Fahrzeuge sind im Zeitraum mit X Sekunden frei?", body: availabilityBody } },
    async (req) => {
      const user = requireCustomer(req);
      const b = req.body;
      if (b.endDate < b.startDate) throw badRequest("invalid_period", "Das Ende darf nicht vor dem Start liegen.");
      if (b.campaignId) await getCampaign(ctx.sql, actorOf(user), b.campaignId);
      const r = await checkAvailability(ctx, {
        from: b.startDate,
        to: b.endDate,
        seconds: b.secondsPerLoop,
        excludeCampaignId: b.campaignId,
      });
      // Kunden sehen nur die Anzahl freier Fahrzeuge, nicht die Gesamtflotte.
      return { available: r.available, loopSeconds: r.loopSeconds };
    },
  );

  // ---------------------------------------------------------------- Kampagnen
  app.get("/campaigns", { schema: { tags } }, async (req) => {
    const user = requireCustomer(req);
    const t = await today(ctx);
    return (await listCampaigns(ctx.sql, actorOf(user))).map((c) => serializeCampaign(c, t));
  });

  app.post(
    "/campaigns",
    {
      schema: {
        tags,
        summary: "Kampagne anlegen (als Entwurf oder direkt gebucht)",
        body: campaignBody.extend({ book: z.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const user = requireCustomer(req);
      const c = await createCampaign(ctx, actorOf(user), req.body);
      return reply.status(201).send(serializeCampaign(c, await today(ctx)));
    },
  );

  app.get("/campaigns/:id", { schema: { tags, params: idParam } }, async (req) => {
    const user = requireCustomer(req);
    const c = await getCampaign(ctx.sql, actorOf(user), req.params.id);
    const { n } = one(
      await ctx.sql<{ n: number }[]>`SELECT count(DISTINCT vehicle_id)::int AS n FROM allocations WHERE campaign_id = ${c.id}`,
    );
    return serializeCampaign({ ...c, allocated_vehicles: n }, await today(ctx));
  });

  app.patch("/campaigns/:id", { schema: { tags, params: idParam, body: campaignBody.partial() } }, async (req) => {
    const user = requireCustomer(req);
    return serializeCampaign(await updateCampaign(ctx, actorOf(user), req.params.id, req.body), await today(ctx));
  });

  app.delete("/campaigns/:id", { schema: { tags, summary: "Entwurf löschen", params: idParam } }, async (req) => {
    const user = requireCustomer(req);
    await deleteDraft(ctx, actorOf(user), req.params.id);
    return { ok: true };
  });

  const action = (path: string, summary: string, fn: typeof bookCampaign) =>
    app.post(path, { schema: { tags, summary, params: idParam } }, async (req) => {
      const user = requireCustomer(req);
      return serializeCampaign(await fn(ctx, actorOf(user), req.params.id), await today(ctx));
    });
  action("/campaigns/:id/book", "Entwurf verbindlich buchen", bookCampaign);
  action("/campaigns/:id/pause", "Pausieren (Kapazität bleibt reserviert)", pauseCampaign);
  action("/campaigns/:id/resume", "Fortsetzen", resumeCampaign);
  action("/campaigns/:id/end", "Beenden bzw. vor Start stornieren", endCampaign);

  // ---------------------------------------------------------------- Motive
  app.get("/campaigns/:id/creatives", { schema: { tags, params: idParam } }, async (req) => {
    const user = requireCustomer(req);
    const c = await getCampaign(ctx.sql, actorOf(user), req.params.id);
    return Promise.all((await listCreatives(ctx.sql, c.id)).map((r) => serializeCreative(ctx, r)));
  });

  app.post(
    "/campaigns/:id/creatives",
    {
      schema: {
        tags,
        summary: "Motiv anlegen – liefert eine Upload-URL (PUT). Danach /uploads/:id/complete aufrufen.",
        params: idParam,
        body: uploadBody,
      },
    },
    async (req, reply) => {
      const user = requireCustomer(req);
      return reply.status(201).send(await requestCreativeUpload(ctx, actorOf(user), req.params.id, req.body));
    },
  );

  app.patch("/creatives/:id", { schema: { tags, params: idParam, body: creativePatch } }, async (req) => {
    const user = requireCustomer(req);
    await updateCreative(ctx, actorOf(user), req.params.id, req.body);
    return { ok: true };
  });

  app.post(
    "/uploads/:id/complete",
    { schema: { tags, summary: "Upload abgeschlossen – Prüfung starten", params: idParam } },
    async (req) => {
      const user = requireCustomer(req);
      await completeUpload(ctx, actorOf(user), req.params.id);
      return { ok: true };
    },
  );
}
