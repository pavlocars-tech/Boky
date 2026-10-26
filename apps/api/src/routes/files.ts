import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { AppError, notFound } from "../lib/errors";
import { LocalStorage } from "../lib/storage";

const CONTENT_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg" };

/**
 * Nur für den lokalen Speicher (Entwicklung/Tests): ersetzt die signierten S3-URLs.
 * In Produktion laufen Up- und Downloads direkt gegen S3.
 */
export async function fileRoutes(app: FastifyInstance, ctx: AppContext) {
  const storage = ctx.storage;
  if (!(storage instanceof LocalStorage)) return;

  // Rohdaten beliebigen Typs annehmen, ohne sie zu parsen.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  const check = (op: "get" | "put", key: string, q: Record<string, string>) => {
    if (!storage.verify(op, key, Number(q.exp), q.sig ?? ""))
      throw new AppError(403, "invalid_signature", "Link ungültig oder abgelaufen.");
  };

  app.put("/*", { bodyLimit: 4 * 1024 * 1024 * 1024 }, async (req) => {
    const key = (req.params as { "*": string })["*"];
    check("put", key, req.query as Record<string, string>);
    const size = await storage.write(key, req.body as NodeJS.ReadableStream as never, 4 * 1024 * 1024 * 1024);
    return { ok: true, size };
  });

  app.get("/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    check("get", key, req.query as Record<string, string>);
    const file = storage.filePath(key);
    const info = await stat(file).catch(() => null);
    if (!info) throw notFound();
    reply.header("Content-Length", info.size);
    reply.type(CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    return reply.send(createReadStream(file));
  });
}
