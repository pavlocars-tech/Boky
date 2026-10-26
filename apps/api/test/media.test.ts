import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs";
import {
  api,
  createAdmin,
  createCustomer,
  createTestEnv,
  createVehicles,
  pairDevice,
  resetDb,
  type Session,
  type TestEnv,
} from "./helpers";

let env: TestEnv;
let admin: Session;
const dir = mkdtempSync(path.join(tmpdir(), "taxiads-media-fixtures-"));
const files = {
  image: path.join(dir, "motiv.png"),
  shortVideo: path.join(dir, "spot-10s.mp4"),
  longVideo: path.join(dir, "spot-20s.mp4"),
  notMedia: path.join(dir, "kaputt.mp4"),
};

beforeAll(async () => {
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc=size=1280x720", "-frames:v", "1", files.image]);
  ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine",
    "-t",
    "10",
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    files.shortVideo,
  ]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "20", "-pix_fmt", "yuv420p", files.longVideo]);
  execFileSync("sh", ["-c", `head -c 5000 /dev/urandom > ${files.notMedia}`]);
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetDb(env.ctx);
  env.clock.now = new Date("2026-11-02T10:00:00Z");
  admin = await createAdmin(env);
});

/** Upload wie im Browser: Upload-URL holen, Datei per PUT hochladen, abschließen. */
async function uploadCreative(session: Session, campaignId: string, file: string, mimeType: string) {
  const created = await api(env, "POST", `/portal/campaigns/${campaignId}/creatives`, {
    session,
    body: { filename: path.basename(file), mimeType, sizeBytes: statSync(file).size },
  });
  expect(created.status).toBe(201);
  const url = new URL(created.json.upload.url);
  const put = await env.app.inject({
    method: "PUT",
    url: url.pathname + url.search,
    headers: { "content-type": mimeType },
    payload: readFileSync(file),
  });
  expect(put.statusCode).toBe(200);
  const done = await api(env, "POST", `/portal/uploads/${created.json.mediaAssetId}/complete`, { session });
  expect(done.status).toBe(200);
  await drainJobs(env.ctx);
  const list = await api(env, "GET", `/portal/campaigns/${campaignId}/creatives`, { session });
  return list.json.find((c: { id: string }) => c.id === created.json.creativeId);
}

async function setup(seconds = 15) {
  const [vehicle] = await createVehicles(env, admin, 1);
  const device = await pairDevice(env, admin, vehicle!);
  const customer = await createCustomer(env);
  const c = await api(env, "POST", "/portal/campaigns", {
    session: customer.session,
    body: {
      name: "Wien Spot",
      startDate: "2026-11-02",
      endDate: "2026-11-30",
      vehicleCount: 1,
      secondsPerLoop: seconds,
      book: true,
    },
  });
  expect(c.status).toBe(201);
  return { vehicle: vehicle!, device, customer, campaignId: c.json.id as string };
}

describe("Upload und Prüfung", () => {
  it("lehnt falsche Dateitypen und zu große Dateien schon vor dem Upload ab", async () => {
    const { customer, campaignId } = await setup();
    const exe = await api(env, "POST", `/portal/campaigns/${campaignId}/creatives`, {
      session: customer.session,
      body: { filename: "virus.exe", mimeType: "application/octet-stream", sizeBytes: 100 },
    });
    expect(exe.json.error).toBe("unsupported_type");
    const big = await api(env, "POST", `/portal/campaigns/${campaignId}/creatives`, {
      session: customer.session,
      body: { filename: "riesig.mp4", mimeType: "video/mp4", sizeBytes: 500 * 1024 * 1024 },
    });
    expect(big.json.error).toBe("file_too_large");
  });

  it("Video länger als die gebuchte Dauer wird abgelehnt", async () => {
    const { customer, campaignId } = await setup(15);
    const creative = await uploadCreative(customer.session, campaignId, files.longVideo, "video/mp4");
    expect(creative.status).toBe("failed");
    expect(creative.reviewNote).toContain("20.0 s lang, gebucht sind 15 s");
  });

  it("kaputte Datei wird abgelehnt", async () => {
    const { customer, campaignId } = await setup(15);
    const creative = await uploadCreative(customer.session, campaignId, files.notMedia, "video/mp4");
    expect(creative.status).toBe("failed");
  });

  it("Video wird umgewandelt (1920×1200, ohne Ton) und wartet auf Freigabe", async () => {
    const { customer, campaignId } = await setup(15);
    const creative = await uploadCreative(customer.session, campaignId, files.shortVideo, "video/mp4");
    expect(creative.status).toBe("pending_review");
    expect(creative.media).toMatchObject({ type: "video", width: 1920, height: 1200, status: "ready" });
    expect(creative.media.durationMs).toBeGreaterThan(9500);
    expect(creative.media.durationMs).toBeLessThanOrEqual(10_100);
    expect(creative.fitsBooking).toBe(true);
  });
});

describe("Freigabe und Ausspielung", () => {
  it("erst nach Freigabe landet das Motiv in der Playlist; Gerät kann die Datei laden", async () => {
    const { device, customer, campaignId } = await setup(15);
    const img = await uploadCreative(customer.session, campaignId, files.image, "image/png");
    expect(img.status).toBe("pending_review");

    const pending = await api(env, "GET", "/admin/creatives", { session: admin });
    expect(pending.json.map((c: { id: string }) => c.id)).toEqual([img.id]);

    let playlist = (await api(env, "GET", "/device/v1/playlist", { token: device.token })).json;
    expect(JSON.stringify(playlist)).not.toContain(img.id);

    const noNote = await api(env, "POST", `/admin/creatives/${img.id}/review`, {
      session: admin,
      body: { decision: "rejected" },
    });
    expect(noNote.status).toBe(400);
    await api(env, "POST", `/admin/creatives/${img.id}/review`, { session: admin, body: { decision: "approved" } });
    await drainJobs(env.ctx);

    playlist = (await api(env, "GET", "/device/v1/playlist", { token: device.token })).json;
    const today = playlist.days[0];
    const slot = today.slots.find((s: { kind: string }) => s.kind === "campaign");
    expect(slot).toMatchObject({ campaignId, durationMs: 15_000 });
    expect(slot.variants[0][0]).toMatchObject({ creativeId: img.id, mediaId: img.media.id });
    expect(today.slots.reduce((s: number, x: { durationMs: number }) => s + x.durationMs, 0)).toBe(300_000);

    const media = playlist.media.find((m: { id: string }) => m.id === img.media.id);
    const redirect = await env.app.inject({
      method: "GET",
      url: media.url,
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(redirect.statusCode).toBe(302);
    const target = new URL(redirect.headers.location as string);
    const file = await env.app.inject({ method: "GET", url: target.pathname + target.search });
    expect(file.statusCode).toBe(200);
    expect(createHash("sha256").update(file.rawPayload).digest("hex")).toBe(media.sha256);
  });

  it("pausierte Kampagne verschwindet aus der Playlist", async () => {
    const { device, customer, campaignId } = await setup(15);
    const img = await uploadCreative(customer.session, campaignId, files.image, "image/png");
    await api(env, "POST", `/admin/creatives/${img.id}/review`, { session: admin, body: { decision: "approved" } });
    await drainJobs(env.ctx);
    await api(env, "POST", `/portal/campaigns/${campaignId}/pause`, { session: customer.session });
    await drainJobs(env.ctx);
    const playlist = (await api(env, "GET", "/device/v1/playlist", { token: device.token })).json;
    expect(playlist.days[0].slots.every((s: { kind: string }) => s.kind === "filler")).toBe(true);
    expect(playlist.days[0].loopMs).toBe(300_000);
  });

  it("Füllinhalte füllen die nicht verkaufte Zeit", async () => {
    const { device } = await setup(15);
    const created = await api(env, "POST", "/admin/fillers", {
      session: admin,
      body: {
        filename: "taxiads.png",
        mimeType: "image/png",
        sizeBytes: statSync(files.image).size,
        title: "TaxiAds Eigenwerbung",
      },
    });
    const url = new URL(created.json.upload.url);
    await env.app.inject({
      method: "PUT",
      url: url.pathname + url.search,
      payload: readFileSync(files.image),
      headers: { "content-type": "image/png" },
    });
    await api(env, "POST", `/admin/uploads/${created.json.mediaAssetId}/complete`, { session: admin });
    await drainJobs(env.ctx);
    const playlist = (await api(env, "GET", "/device/v1/playlist", { token: device.token })).json;
    const pieces = playlist.days[0].slots.flatMap((s: { variants: { fillerId?: string }[][] }) => s.variants[0]);
    expect(pieces.every((p: { fillerId?: string }) => p.fillerId === created.json.fillerId)).toBe(true);
  });
});
