import { dailyUsage, systemSettingsBaseSchema } from "@taxiads/shared";
import { z } from "zod";
import type { App } from "../app";
import { actorOf, type AppContext } from "../context";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { badRequest, conflict, notFound } from "../lib/errors";
import { loadSettings, saveSettings } from "../lib/settings";
import { loadVehicleLoads, today } from "../services/booking";
import {
  bookCampaign,
  createCampaign,
  endCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  serializeCampaign,
  updateCampaign,
} from "../services/campaigns";
import { assignDevice, claimPairing } from "../services/devices";
import {
  completeUpload,
  listCreatives,
  requestFillerUpload,
  reviewCreative,
  serializeCreative,
  updateCreative,
} from "../services/media";
import { enqueueAllPlaylists, latestPlaylist, rebuildPlaylist, requestPlaylistRebuild } from "../services/playlists";
import { createUserToken } from "./auth";
import { campaignBody, creativePatch, idParam, isoDate, uploadBody } from "./schemas";

const tags = ["Admin"];

export async function adminRoutes(app: App, ctx: AppContext) {
  app.addHook("preHandler", async (req) => {
    requireAdmin(req);
  });

  // ---------------------------------------------------------------- Fahrzeuge
  app.get("/vehicles", { schema: { tags } }, async () => {
    const settings = await loadSettings(ctx.sql);
    const t = await today(ctx);
    const vehicles = await ctx.sql`
      SELECT v.id, v.label, v.license_plate AS "licensePlate", v.notes, v.active, v.created_at AS "createdAt",
        coalesce((
          SELECT sum(a.seconds_per_loop)::int FROM allocations a JOIN campaigns c ON c.id = a.campaign_id
          WHERE a.vehicle_id = v.id AND a.period @> ${t}::date AND c.status IN ('booked', 'paused', 'ended')
        ), 0) AS "soldSecondsToday",
        (SELECT count(*)::int FROM devices d WHERE d.vehicle_id = v.id) AS "deviceCount"
      FROM vehicles v ORDER BY v.label
    `;
    return vehicles.map((v) => ({ ...v, loopSeconds: settings.loopSeconds }));
  });

  const vehicleBody = z.object({
    label: z.string().trim().min(1).max(100),
    licensePlate: z.string().trim().max(20).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  });

  app.post("/vehicles", { schema: { tags, body: vehicleBody } }, async (req, reply) => {
    const admin = requireAdmin(req);
    const b = req.body;
    try {
      const [v] = await ctx.sql<{ id: string }[]>`
        INSERT INTO vehicles (label, license_plate, notes, active)
        VALUES (${b.label}, ${b.licensePlate ?? null}, ${b.notes ?? null}, ${b.active ?? true})
        RETURNING id
      `;
      await audit(ctx.sql, admin.id, "vehicle.create", "vehicle", v!.id, { ...b });
      await requestPlaylistRebuild(ctx.sql, [v!.id]);
      return reply.status(201).send({ id: v!.id });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict("label_taken", "Bezeichnung bereits vergeben.");
      throw err;
    }
  });

  app.patch("/vehicles/:id", { schema: { tags, params: idParam, body: vehicleBody.partial() } }, async (req) => {
    const admin = requireAdmin(req);
    const b = req.body;
    const [v] = await ctx.sql`
      UPDATE vehicles SET
        label = coalesce(${b.label ?? null}, label),
        license_plate = CASE WHEN ${b.licensePlate !== undefined} THEN ${b.licensePlate ?? null} ELSE license_plate END,
        notes = CASE WHEN ${b.notes !== undefined} THEN ${b.notes ?? null} ELSE notes END,
        active = coalesce(${b.active ?? null}, active)
      WHERE id = ${req.params.id} RETURNING id
    `;
    if (!v) throw notFound("Fahrzeug nicht gefunden.");
    await audit(ctx.sql, admin.id, "vehicle.update", "vehicle", req.params.id, { ...b });
    return { ok: true };
  });

  app.get(
    "/vehicles/:id/playlist",
    { schema: { tags, summary: "Aktuelle Playlist eines Fahrzeugs", params: idParam } },
    async (req) => {
      const playlist = await latestPlaylist(ctx.sql, req.params.id);
      if (!playlist) throw notFound("Noch keine Playlist.");
      return playlist;
    },
  );

  app.post("/vehicles/:id/playlist/rebuild", { schema: { tags, params: idParam } }, async (req) => {
    return rebuildPlaylist(ctx, req.params.id);
  });

  app.post("/playlists/rebuild-all", { schema: { tags } }, async () => {
    return { queued: await enqueueAllPlaylists(ctx.sql) };
  });

  // ---------------------------------------------------------------- Auslastung
  app.get(
    "/utilization",
    {
      schema: {
        tags,
        summary: "Verkaufte Sekunden je Fahrzeug und Tag",
        querystring: z.object({ from: isoDate, to: isoDate }),
      },
    },
    async (req) => {
      const { from, to } = req.query;
      if (to < from) throw badRequest("invalid_period", "Das Ende darf nicht vor dem Start liegen.");
      const settings = await loadSettings(ctx.sql);
      const loads = await loadVehicleLoads(ctx.sql, from, to, null, ctx.now());
      const labels = new Map(
        (await ctx.sql<{ id: string; label: string }[]>`SELECT id, label FROM vehicles`).map((v) => [v.id, v.label]),
      );
      const vehicles = loads.map((l) => {
        const days = dailyUsage(l.allocations, from, to);
        return {
          vehicleId: l.vehicleId,
          label: labels.get(l.vehicleId),
          peakSeconds: Math.max(0, ...days),
          averageSeconds: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : 0,
          days,
        };
      });
      const total = vehicles.reduce((s, v) => s + v.averageSeconds, 0);
      return {
        from,
        to,
        loopSeconds: settings.loopSeconds,
        averageUtilization: vehicles.length ? total / (vehicles.length * settings.loopSeconds) : 0,
        vehicles,
      };
    },
  );

  // ---------------------------------------------------------------- Geräte
  app.get("/devices", { schema: { tags } }, async () => {
    const settings = await loadSettings(ctx.sql);
    const onlineAfter = new Date(ctx.now().getTime() - 3 * settings.heartbeatIntervalSeconds * 1000);
    return ctx.sql`
      SELECT d.id, d.name, d.status, d.vehicle_id AS "vehicleId", v.label AS "vehicleLabel", d.screen_slot AS "screenSlot",
        d.model, d.android_version AS "androidVersion", d.app_version AS "appVersion", d.paired_at AS "pairedAt",
        d.last_seen_at AS "lastSeenAt", (d.last_seen_at > ${onlineAfter}) IS TRUE AS online,
        d.last_playlist_version AS "playlistVersion",
        (SELECT max(p.version) FROM playlists p WHERE p.vehicle_id = d.vehicle_id) AS "latestPlaylistVersion",
        d.last_free_storage_bytes::float8 AS "freeStorageBytes", d.last_battery_percent AS "batteryPercent",
        d.last_brightness_percent AS "brightnessPercent", d.last_clock_skew_ms AS "clockSkewMs",
        d.last_now_playing AS "nowPlaying", d.last_pending AS "pending",
        ST_Y(d.last_position::geometry) AS lat, ST_X(d.last_position::geometry) AS lon, d.last_position_at AS "positionAt"
      FROM devices d LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ORDER BY v.label NULLS LAST, d.screen_slot
    `;
  });

  app.post(
    "/devices/claim",
    {
      schema: {
        tags,
        summary: "Neues Gerät per Kopplungscode einem Fahrzeug zuordnen",
        body: z.object({
          code: z.string().regex(/^\d{6}$/, "6-stelliger Code"),
          vehicleId: z.uuid(),
          screenSlot: z.number().int().min(1).optional(),
          name: z.string().max(100).optional(),
          replace: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const admin = requireAdmin(req);
      const deviceId = await claimPairing(ctx, admin.id, req.body);
      return reply.status(201).send({ deviceId });
    },
  );

  app.patch(
    "/devices/:id",
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({
          name: z.string().max(100).nullable().optional(),
          status: z.enum(["active", "blocked"]).optional(),
          vehicleId: z.uuid().nullable().optional(),
          screenSlot: z.number().int().min(1).nullable().optional(),
          replace: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      const b = req.body;
      const [d] = await ctx.sql<{ id: string }[]>`SELECT id FROM devices WHERE id = ${req.params.id}`;
      if (!d) throw notFound("Gerät nicht gefunden.");
      if (b.name !== undefined) await ctx.sql`UPDATE devices SET name = ${b.name} WHERE id = ${d.id}`;
      if (b.status) {
        await ctx.sql`UPDATE devices SET status = ${b.status} WHERE id = ${d.id}`;
        await audit(ctx.sql, admin.id, `device.${b.status === "blocked" ? "block" : "unblock"}`, "device", d.id);
      }
      if (b.vehicleId !== undefined) {
        await assignDevice(ctx, admin.id, d.id, { vehicleId: b.vehicleId, screenSlot: b.screenSlot, replace: b.replace });
      }
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- Kunden
  app.get("/customers", { schema: { tags } }, async () => {
    return ctx.sql`
      SELECT c.id, c.name, c.status, c.contact_email AS "contactEmail", c.phone, c.vat_id AS "vatId", c.address,
        c.created_at AS "createdAt",
        (SELECT count(*)::int FROM users u WHERE u.customer_id = c.id) AS "userCount",
        (SELECT count(*)::int FROM campaigns k WHERE k.customer_id = c.id AND k.status IN ('booked', 'paused')) AS "activeCampaigns"
      FROM customers c ORDER BY c.name
    `;
  });

  app.get("/customers/:id", { schema: { tags, params: idParam } }, async (req) => {
    const [customer] = await ctx.sql`SELECT * FROM customers WHERE id = ${req.params.id}`;
    if (!customer) throw notFound("Kunde nicht gefunden.");
    const users = await ctx.sql`
      SELECT id, email, name, customer_role AS role, status, email_verified_at AS "emailVerifiedAt", last_login_at AS "lastLoginAt"
      FROM users WHERE customer_id = ${req.params.id} ORDER BY created_at
    `;
    return { customer, users };
  });

  app.patch(
    "/customers/:id",
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({ name: z.string().trim().min(2).max(200).optional(), status: z.enum(["active", "blocked"]).optional() }),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      const [c] = await ctx.sql`
        UPDATE customers SET name = coalesce(${req.body.name ?? null}, name), status = coalesce(${req.body.status ?? null}, status)
        WHERE id = ${req.params.id} RETURNING id
      `;
      if (!c) throw notFound("Kunde nicht gefunden.");
      await audit(ctx.sql, admin.id, "customer.update", "customer", req.params.id, { ...req.body });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- Kampagnen
  app.get(
    "/campaigns",
    {
      schema: {
        tags,
        querystring: z.object({
          customerId: z.uuid().optional(),
          status: z.enum(["draft", "booked", "paused", "ended", "cancelled"]).optional(),
        }),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      const t = await today(ctx);
      return (await listCampaigns(ctx.sql, actorOf(admin), req.query)).map((c) => serializeCampaign(c, t));
    },
  );

  app.post(
    "/campaigns",
    { schema: { tags, body: campaignBody.extend({ customerId: z.uuid(), book: z.boolean().default(false) }) } },
    async (req, reply) => {
      const admin = requireAdmin(req);
      return reply.status(201).send(serializeCampaign(await createCampaign(ctx, actorOf(admin), req.body), await today(ctx)));
    },
  );

  app.get("/campaigns/:id", { schema: { tags, params: idParam } }, async (req) => {
    const admin = requireAdmin(req);
    const c = await getCampaign(ctx.sql, actorOf(admin), req.params.id);
    const allocations = await ctx.sql`
      SELECT a.vehicle_id AS "vehicleId", v.label AS "vehicleLabel", a.start_date AS "startDate", a.end_date AS "endDate",
        a.seconds_per_loop AS "secondsPerLoop"
      FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id
      WHERE a.campaign_id = ${c.id} ORDER BY v.label, a.start_date
    `;
    return { ...serializeCampaign(c, await today(ctx)), allocations };
  });

  app.patch("/campaigns/:id", { schema: { tags, params: idParam, body: campaignBody.partial() } }, async (req) => {
    const admin = requireAdmin(req);
    return serializeCampaign(await updateCampaign(ctx, actorOf(admin), req.params.id, req.body), await today(ctx));
  });

  const action = (path: string, fn: typeof bookCampaign) =>
    app.post(path, { schema: { tags, params: idParam } }, async (req) => {
      const admin = requireAdmin(req);
      return serializeCampaign(await fn(ctx, actorOf(admin), req.params.id), await today(ctx));
    });
  action("/campaigns/:id/book", bookCampaign);
  action("/campaigns/:id/pause", pauseCampaign);
  action("/campaigns/:id/resume", resumeCampaign);
  action("/campaigns/:id/end", endCampaign);

  app.get("/campaigns/:id/creatives", { schema: { tags, params: idParam } }, async (req) => {
    return Promise.all((await listCreatives(ctx.sql, req.params.id)).map((r) => serializeCreative(ctx, r)));
  });

  // ---------------------------------------------------------------- Freigaben
  app.get(
    "/creatives",
    {
      schema: {
        tags,
        summary: "Motive, z. B. alle wartenden Freigaben",
        querystring: z.object({ status: z.string().default("pending_review") }),
      },
    },
    async (req) => {
      const rows = await ctx.sql<{ campaign_id: string }[]>`
        SELECT DISTINCT campaign_id FROM creatives WHERE status = ${req.query.status}
      `;
      const out = [];
      for (const r of rows) {
        const [c] = await ctx.sql<{ name: string; customer_name: string }[]>`
          SELECT c.name, cu.name AS customer_name FROM campaigns c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ${r.campaign_id}
        `;
        for (const cr of await listCreatives(ctx.sql, r.campaign_id)) {
          if (cr.status !== req.query.status) continue;
          out.push({ ...(await serializeCreative(ctx, cr)), campaignName: c?.name, customerName: c?.customer_name });
        }
      }
      return out;
    },
  );

  app.post(
    "/creatives/:id/review",
    {
      schema: {
        tags,
        summary: "Motiv freigeben oder ablehnen",
        params: idParam,
        body: z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() }),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      await reviewCreative(ctx, admin.id, req.params.id, req.body.decision, req.body.note);
      return { ok: true };
    },
  );

  app.patch("/creatives/:id", { schema: { tags, params: idParam, body: creativePatch } }, async (req) => {
    const admin = requireAdmin(req);
    await updateCreative(ctx, actorOf(admin), req.params.id, req.body);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Füllinhalte
  app.get("/fillers", { schema: { tags } }, async () => {
    const rows = await ctx.sql<
      {
        id: string;
        title: string;
        active: boolean;
        sort_order: number;
        start_date: string | null;
        end_date: string | null;
        media_asset_id: string;
        media_type: string | null;
        duration_ms: number | null;
        status: string;
        error: string | null;
        processed_key: string | null;
      }[]
    >`
      SELECT f.id, f.title, f.active, f.sort_order, f.start_date, f.end_date, m.id AS media_asset_id, m.media_type,
        m.duration_ms, m.status, m.error, m.processed_key
      FROM fillers f JOIN media_assets m ON m.id = f.media_asset_id
      ORDER BY f.sort_order, f.created_at
    `;
    return Promise.all(
      rows.map(async (f) => ({
        id: f.id,
        title: f.title,
        active: f.active,
        sortOrder: f.sort_order,
        startDate: f.start_date,
        endDate: f.end_date,
        media: {
          id: f.media_asset_id,
          type: f.media_type,
          durationMs: f.duration_ms,
          status: f.status,
          error: f.error,
          previewUrl: f.processed_key ? await ctx.storage.presignDownload(f.processed_key, 3600) : null,
        },
      })),
    );
  });

  app.post(
    "/fillers",
    { schema: { tags, summary: "Füllinhalt anlegen – liefert Upload-URL", body: uploadBody } },
    async (req, reply) => {
      const admin = requireAdmin(req);
      return reply.status(201).send(await requestFillerUpload(ctx, admin.id, req.body));
    },
  );

  app.patch(
    "/fillers/:id",
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({
          title: z.string().trim().min(1).max(200).optional(),
          active: z.boolean().optional(),
          sortOrder: z.number().int().min(0).optional(),
          startDate: isoDate.nullable().optional(),
          endDate: isoDate.nullable().optional(),
        }),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      const b = req.body;
      const [f] = await ctx.sql`
        UPDATE fillers SET
          title = coalesce(${b.title ?? null}, title),
          active = coalesce(${b.active ?? null}, active),
          sort_order = coalesce(${b.sortOrder ?? null}, sort_order),
          start_date = CASE WHEN ${b.startDate !== undefined} THEN ${b.startDate ?? null}::date ELSE start_date END,
          end_date = CASE WHEN ${b.endDate !== undefined} THEN ${b.endDate ?? null}::date ELSE end_date END
        WHERE id = ${req.params.id} RETURNING id
      `;
      if (!f) throw notFound("Füllinhalt nicht gefunden.");
      await audit(ctx.sql, admin.id, "filler.update", "filler", req.params.id, { ...b });
      await requestPlaylistRebuild(ctx.sql, "all");
      return { ok: true };
    },
  );

  app.post("/uploads/:id/complete", { schema: { tags, params: idParam } }, async (req) => {
    const admin = requireAdmin(req);
    await completeUpload(ctx, actorOf(admin), req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Einstellungen
  app.get("/settings", { schema: { tags } }, async () => loadSettings(ctx.sql, { fresh: true }));

  app.patch(
    "/settings",
    {
      schema: {
        tags,
        summary: "Schleifenlänge, Buchungsgrenzen, GPS-Intervall, Helligkeitszeitplan …",
        body: systemSettingsBaseSchema.partial(),
      },
    },
    async (req) => {
      const admin = requireAdmin(req);
      const saved = await saveSettings(ctx.sql, req.body, admin.id);
      await audit(ctx.sql, admin.id, "settings.update", "settings", null, { ...req.body });
      // Schleifenlänge, Füllbilddauer usw. wirken sich auf alle Playlists aus.
      await requestPlaylistRebuild(ctx.sql, "all");
      return saved;
    },
  );

  // ---------------------------------------------------------------- Admins
  app.get("/admins", { schema: { tags } }, async () => {
    return ctx.sql`SELECT id, email, name, status, last_login_at AS "lastLoginAt" FROM users WHERE role = 'admin' ORDER BY name`;
  });

  app.post(
    "/admins",
    {
      schema: {
        tags,
        summary: "Weiteren Admin einladen",
        body: z.object({ email: z.email().transform((e) => e.trim().toLowerCase()), name: z.string().trim().min(2).max(200) }),
      },
    },
    async (req, reply) => {
      const admin = requireAdmin(req);
      const [existing] = await ctx.sql`SELECT id FROM users WHERE email = ${req.body.email}`;
      if (existing) throw conflict("email_taken", "Für diese E-Mail-Adresse gibt es bereits ein Konto.");
      const token = await ctx.sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          INSERT INTO users (email, name, role, status) VALUES (${req.body.email}, ${req.body.name}, 'admin', 'invited') RETURNING id
        `;
        await audit(tx, admin.id, "admin.invite", "user", u!.id);
        return createUserToken(tx, u!.id, "invite", 24 * 7, ctx.now());
      });
      await ctx.mailer.send({
        to: req.body.email,
        subject: "Einladung in den TaxiAds-Admin-Bereich",
        text: `Konto einrichten (7 Tage gültig):\n${ctx.config.WEB_URL}/einladung?token=${encodeURIComponent(token)}`,
      });
      return reply.status(201).send({ ok: true });
    },
  );
}
