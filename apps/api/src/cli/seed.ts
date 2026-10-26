/**
 * Demodaten für die lokale Entwicklung:
 *  - Admin:  admin@taxiads.local / admin-passwort-123
 *  - Kunde:  kunde@example.com   / kunden-passwort-123 (Bäckerei Huber)
 *  - 20 Taxis, 2 Füllinhalte, eine gebuchte Kampagne mit freigegebenem Motiv
 * Erzeugt Testbilder/-videos mit ffmpeg und durchläuft dieselbe Verarbeitung wie echte Uploads.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDays, localDate } from "@taxiads/shared";
import { createContext } from "../bootstrap";
import type { Actor } from "../context";
import { migrate, one } from "../db";
import { hashPassword } from "../lib/crypto";
import { ensureUpcomingPartitions } from "../lib/partitions";
import { loadSettings } from "../lib/settings";
import { drainJobs } from "../jobs";
import { createCampaign } from "../services/campaigns";
import { completeUpload, requestCreativeUpload, requestFillerUpload, reviewCreative } from "../services/media";

const ctx = createContext();
const { sql } = ctx;
await migrate(sql, undefined, (m) => console.log(m));
await ensureUpcomingPartitions(sql, new Date());

const [already] = await sql`SELECT 1 FROM users WHERE email = 'admin@taxiads.local'`;
if (already) {
  console.log("Demodaten sind bereits vorhanden.");
  await sql.end();
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "taxiads-seed-"));
const ff = (args: string[]) => execFileSync(ctx.config.FFMPEG_PATH, ["-y", "-loglevel", "error", ...args]);
const fillerImage = path.join(dir, "taxiads-eigenwerbung.png");
const fillerVideo = path.join(dir, "taxiads-wien.mp4");
const creativeImage = path.join(dir, "baeckerei-huber.png");
ff(["-f", "lavfi", "-i", "color=c=0xF5C400:s=1920x1200", "-frames:v", "1", fillerImage]);
ff(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "20", "-pix_fmt", "yuv420p", fillerVideo]);
ff(["-f", "lavfi", "-i", "smptebars=size=1920x1200", "-frames:v", "1", creativeImage]);

/** Simuliert den Browser-Upload direkt über den Speicher. */
async function put(upload: { url: string }, file: string) {
  const res = await fetch(upload.url, { method: "PUT", body: readFileSync(file) });
  if (!res.ok) throw new Error(`Upload fehlgeschlagen: ${res.status} – läuft die API (pnpm dev:api)?`);
}

const adminHash = await hashPassword("admin-passwort-123");
const admin = one(
  await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, name, role, email_verified_at)
    VALUES ('admin@taxiads.local', ${adminHash}, 'TaxiAds Admin', 'admin', now()) RETURNING id
  `,
);
const customer = one(
  await sql<{ id: string }[]>`
    INSERT INTO customers (name, address, contact_email) VALUES ('Bäckerei Huber', 'Mariahilfer Straße 1, 1060 Wien', 'kunde@example.com')
    RETURNING id
  `,
);
const customerUser = one(
  await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, name, role, customer_id, customer_role, email_verified_at)
    VALUES ('kunde@example.com', ${await hashPassword("kunden-passwort-123")}, 'Maria Huber', 'customer', ${customer.id}, 'owner', now())
    RETURNING id
  `,
);
for (let i = 1; i <= 20; i++) {
  await sql`INSERT INTO vehicles (label, license_plate) VALUES (${`TAXI-${String(i).padStart(3, "0")}`}, ${`W-${1000 + i} TX`})`;
}
console.log("Admin, Kunde und 20 Fahrzeuge angelegt.");

const adminActor: Actor = { role: "admin", userId: admin.id };
for (const [file, mime, title] of [
  [fillerImage, "image/png", "TaxiAds – Ihre Werbung hier"],
  [fillerVideo, "video/mp4", "TaxiAds Imagefilm"],
] as const) {
  const f = await requestFillerUpload(ctx, admin.id, {
    filename: path.basename(file),
    mimeType: mime,
    sizeBytes: statSync(file).size,
    title,
  });
  await put(f.upload, file);
  await completeUpload(ctx, adminActor, f.mediaAssetId);
}

const settings = await loadSettings(sql);
const today = localDate(new Date(), settings.timezone);
const customerActor: Actor = { role: "customer", userId: customerUser.id, customerId: customer.id, customerRole: "owner" };
const campaign = await createCampaign(ctx, customerActor, {
  name: "Frische Semmeln – Herbst",
  startDate: today,
  endDate: addDays(today, 30),
  vehicleCount: 10,
  secondsPerLoop: 15,
  book: true,
});
const cr = await requestCreativeUpload(ctx, customerActor, campaign.id, {
  filename: path.basename(creativeImage),
  mimeType: "image/png",
  sizeBytes: statSync(creativeImage).size,
  title: "Semmel-Motiv",
});
await put(cr.upload, creativeImage);
await completeUpload(ctx, customerActor, cr.mediaAssetId);
await drainJobs(ctx);
await reviewCreative(ctx, admin.id, cr.creativeId, "approved");
await drainJobs(ctx);
console.log(`Kampagne "${campaign.name}" auf 10 Fahrzeugen gebucht, Motiv freigegeben, Playlists erzeugt.`);
console.log("\nAnmeldung:\n  Admin: admin@taxiads.local / admin-passwort-123\n  Kunde: kunde@example.com / kunden-passwort-123");
await sql.end();
