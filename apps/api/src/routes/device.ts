import { gpsBatchSchema, heartbeatSchema, pairingStartSchema, playbackBatchSchema, tokenRequestSchema } from "@taxiads/shared";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { App } from "../app";
import type { AppContext } from "../context";
import { authenticateDevice } from "../lib/auth";
import { AppError, notFound } from "../lib/errors";
import {
  deviceConfig,
  exchangeDeviceAssertion,
  getPairing,
  ingestGpsPoints,
  ingestPlaybackEvents,
  mediaKeyForDevice,
  recordHeartbeat,
  startPairing,
} from "../services/devices";
import { latestPlaylist, rebuildPlaylist } from "../services/playlists";

const tags = ["Player"];
const security = [{ device: [] }];

/** Schnittstelle für die Player-App. Alles außer Kopplung/Anmeldung braucht ein Gerätetoken. */
export async function deviceRoutes(app: App, ctx: AppContext) {
  app.post(
    "/pairing",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags, summary: "Gerät startet Kopplung, erhält 6-stelligen Code", body: pairingStartSchema },
    },
    async (req, reply) => reply.status(201).send(await startPairing(ctx, req.body)),
  );

  app.get(
    "/pairing/:id",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { tags, summary: "Status der Kopplung abfragen", params: z.object({ id: z.uuid() }) },
    },
    async (req) => getPairing(ctx, req.params.id),
  );

  app.post(
    "/token",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { tags, summary: "Signiertes Geräte-JWT gegen Zugriffstoken tauschen", body: tokenRequestSchema },
    },
    async (req) => exchangeDeviceAssertion(ctx, req.body.assertion),
  );

  await app.register(async (inner) => {
    const authed = inner.withTypeProvider<ZodTypeProvider>();
    authed.addHook("preHandler", async (req) => {
      req.device = await authenticateDevice(ctx, req);
    });

    authed.get("/config", { schema: { tags, security } }, async (req) => deviceConfig(ctx, req.device!));

    authed.post("/heartbeat", { schema: { tags, security, body: heartbeatSchema } }, async (req) =>
      recordHeartbeat(ctx, req.device!, req.body, req.ip),
    );

    authed.get(
      "/playlist",
      {
        schema: {
          tags,
          security,
          summary: "Aktuelle Playlist; 304, wenn `version` schon aktuell ist",
          querystring: z.object({ version: z.coerce.number().int().optional() }),
        },
      },
      async (req, reply) => {
        const device = req.device!;
        if (!device.vehicleId) throw new AppError(409, "not_assigned", "Gerät ist keinem Fahrzeug zugeordnet.");
        let playlist = await latestPlaylist(ctx.sql, device.vehicleId);
        if (!playlist) {
          await rebuildPlaylist(ctx, device.vehicleId);
          playlist = await latestPlaylist(ctx.sql, device.vehicleId);
        }
        if (!playlist) throw notFound("Keine Playlist.");
        if (req.query.version === playlist.version) return reply.status(304).send();
        return playlist;
      },
    );

    authed.get(
      "/media/:id",
      { schema: { tags, security, summary: "Weiterleitung auf kurzlebige Download-URL", params: z.object({ id: z.uuid() }) } },
      async (req, reply) => {
        const key = await mediaKeyForDevice(ctx.sql, req.device!, req.params.id);
        return reply.redirect(await ctx.storage.presignDownload(key, 3600), 302);
      },
    );

    authed.post(
      "/playback-events",
      {
        bodyLimit: 2 * 1024 * 1024,
        schema: { tags, security, summary: "Ausspiel-Logs (Batch, idempotent)", body: playbackBatchSchema },
      },
      async (req) => ingestPlaybackEvents(ctx, req.device!, req.body.events),
    );

    authed.post(
      "/gps",
      { bodyLimit: 2 * 1024 * 1024, schema: { tags, security, summary: "GPS-Punkte (Batch, idempotent)", body: gpsBatchSchema } },
      async (req) => ingestGpsPoints(ctx, req.device!, req.body.points),
    );
  });
}
