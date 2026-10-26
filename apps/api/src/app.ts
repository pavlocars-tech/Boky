import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { AppContext } from "./context";
import { SESSION_COOKIE, userFromSession } from "./lib/auth";
import { AppError } from "./lib/errors";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { deviceRoutes } from "./routes/device";
import { fileRoutes } from "./routes/files";
import { portalRoutes } from "./routes/portal";

export type App = ReturnType<typeof withZod>;
const withZod = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: ctx.config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const origins = ctx.config.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie);
  if (ctx.config.RATE_LIMIT_ENABLED) await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: { title: "TaxiAds API", version: "1.0.0", description: "Backend für Player, Admin-Bereich und Kundenportal" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
          device: { type: "http", scheme: "bearer" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Sitzung aus Cookie laden.
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.user = await userFromSession(ctx, token);
  });

  // CSRF-Schutz: Ändernde Anfragen mit Session-Cookie nur von erlaubten Origins.
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.cookies[SESSION_COOKIE]) return;
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin) && origin !== ctx.config.PUBLIC_API_URL) {
      throw new AppError(403, "invalid_origin", "Anfrage von unbekannter Herkunft.");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: "validation_error",
        message: "Ungültige Eingabe.",
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as { code?: string }).code ?? "error", message: (err as Error).message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: "Interner Fehler." });
  });

  app.get("/health", async () => {
    await ctx.sql`SELECT 1`;
    return { ok: true, time: ctx.now().toISOString() };
  });

  await app.register(async (a) => authRoutes(withZod(a), ctx), { prefix: "/auth" });
  await app.register(async (a) => portalRoutes(withZod(a), ctx), { prefix: "/portal" });
  await app.register(async (a) => adminRoutes(withZod(a), ctx), { prefix: "/admin" });
  await app.register(async (a) => deviceRoutes(withZod(a), ctx), { prefix: "/device/v1" });
  await app.register(async (a) => fileRoutes(a, ctx), { prefix: "/files" });

  return app;
}
