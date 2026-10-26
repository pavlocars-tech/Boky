import { loadConfig, type Config } from "./config";
import type { AppContext } from "./context";
import { createDb } from "./db";
import { LogMailer, SmtpMailer, type Mailer } from "./lib/mailer";
import { createStorage } from "./lib/storage";

/** Baut den Anwendungskontext aus der Umgebung (API, Worker, CLI). */
export function createContext(overrides: Partial<AppContext> & { config?: Config } = {}): AppContext {
  const config = overrides.config ?? loadConfig();
  const log = overrides.log ?? {
    info: (...a: unknown[]) => console.log(...a),
    warn: (...a: unknown[]) => console.warn(...a),
    error: (...a: unknown[]) => console.error(...a),
  };
  const mailer: Mailer =
    overrides.mailer ?? (config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) : new LogMailer((m) => log.info(m)));
  return {
    config,
    sql: overrides.sql ?? createDb(config.DATABASE_URL, config.DATABASE_POOL_SIZE),
    storage: overrides.storage ?? createStorage(config),
    mailer,
    log: log as AppContext["log"],
    now: overrides.now ?? (() => new Date()),
  };
}
