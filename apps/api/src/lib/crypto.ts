import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** Zufälliges, URL-sicheres Token (für Sessions, E-Mail-Links). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Kopplungscode: 6 Ziffern, gut abzulesen und einzutippen. */
export function pairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPassword(password: string): Promise<string> {
  // argon2id mit OWASP-Empfehlung (19 MiB, 2 Durchläufe)
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}
