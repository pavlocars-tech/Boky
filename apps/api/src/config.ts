import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().default("postgres://taxiads:taxiads@localhost:5432/taxiads"),
  DATABASE_POOL_SIZE: z.coerce.number().int().default(10),
  /** Öffentliche Adresse der API (für Datei-Links). */
  PUBLIC_API_URL: z.string().default("http://localhost:3000"),
  /** Öffentliche Adresse der Web-Oberfläche (für Links in E-Mails). */
  WEB_URL: z.string().default("http://localhost:3001"),
  CORS_ORIGINS: z.string().default("http://localhost:3001"),
  COOKIE_SECURE: bool.optional(),
  RATE_LIMIT_ENABLED: bool.default(true),
  SESSION_TTL_DAYS: z.coerce.number().int().default(30),
  /** Geheimnis für Geräte-Zugriffstokens und signierte Datei-URLs (mind. 32 Zeichen). */
  APP_SECRET: z.string().min(32).default("dev-secret-change-me-dev-secret-change-me"),
  DEVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default(".data/storage"),
  S3_ENDPOINT: z.string().optional(),
  /** Für Browser/Geräte erreichbare Adresse des Speichers, falls abweichend (z. B. Docker: localhost statt minio). */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  /** Bucket beim Start anlegen, falls er fehlt (nur für lokale Entwicklung). */
  S3_CREATE_BUCKET: bool.default(false),
  S3_REGION: z.string().default("eu-central-1"),
  S3_BUCKET: z.string().default("taxiads-media"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("TaxiAds <no-reply@taxiads.local>"),
  MEDIA_TARGET_WIDTH: z.coerce.number().int().default(1920),
  MEDIA_TARGET_HEIGHT: z.coerce.number().int().default(1200),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
});

export type Config = z.infer<typeof envSchema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Ungültige Konfiguration: ${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production" && c.APP_SECRET.startsWith("dev-secret")) {
    throw new Error("APP_SECRET muss in Produktion gesetzt werden.");
  }
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === "production" };
}
