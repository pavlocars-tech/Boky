import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config";
import type { Sql } from "./db";
import type { Mailer } from "./lib/mailer";
import type { Storage } from "./lib/storage";

/** Gemeinsame Abhängigkeiten für Routen, Services und Worker. */
export interface AppContext {
  sql: Sql;
  config: Config;
  storage: Storage;
  mailer: Mailer;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Aktuelle Zeit; in Tests austauschbar. */
  now: () => Date;
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "customer";
  customerId: string | null;
  customerRole: "owner" | "member" | null;
};

/** Wer eine Aktion ausführt – bestimmt die Sichtbarkeit von Daten. */
export type Actor =
  { userId: string; role: "admin" } | { userId: string; role: "customer"; customerId: string; customerRole: "owner" | "member" };

export function actorOf(user: SessionUser): Actor {
  if (user.role === "admin") return { userId: user.id, role: "admin" };
  return { userId: user.id, role: "customer", customerId: user.customerId!, customerRole: user.customerRole! };
}
