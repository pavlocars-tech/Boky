import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Actor, AppContext } from "../context";
import { one, type Db } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound } from "../lib/errors";
import { enqueue } from "../lib/jobs";
import { loadSettings } from "../lib/settings";
import { getCampaign } from "./campaigns";
import { requestPlaylistRebuild, VIDEO_TOLERANCE_MS } from "./playlists";

const run = promisify(execFile);

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

function safeFilename(name: string): string {
  const base = path
    .basename(name)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_");
  return base.slice(-100) || "datei";
}

interface UploadRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

async function validateUploadRequest(db: Db, req: UploadRequest) {
  const settings = await loadSettings(db);
  const isImage = IMAGE_MIME_TYPES.includes(req.mimeType);
  const isVideo = VIDEO_MIME_TYPES.includes(req.mimeType);
  if (!isImage && !isVideo) {
    throw badRequest("unsupported_type", "Erlaubt sind Bilder (JPG, PNG, WebP) und Videos (MP4, MOV, WebM, MKV).");
  }
  const maxMb = isImage ? settings.maxImageUploadMb : settings.maxVideoUploadMb;
  if (req.sizeBytes > maxMb * 1024 * 1024) throw badRequest("file_too_large", `Datei zu groß (höchstens ${maxMb} MB).`);
  if (req.sizeBytes <= 0) throw badRequest("file_empty", "Datei ist leer.");
}

async function createAsset(
  ctx: AppContext,
  db: Db,
  purpose: "creative" | "filler",
  customerId: string | null,
  userId: string,
  req: UploadRequest,
) {
  const [asset] = await db<{ id: string }[]>`
    INSERT INTO media_assets (purpose, customer_id, original_key, original_filename, declared_mime_type, declared_size_bytes, created_by)
    VALUES (${purpose}, ${customerId}, '', ${req.filename}, ${req.mimeType}, ${req.sizeBytes}, ${userId})
    RETURNING id
  `;
  const key = `originals/${asset!.id}/${safeFilename(req.filename)}`;
  await db`UPDATE media_assets SET original_key = ${key} WHERE id = ${asset!.id}`;
  const upload = await ctx.storage.presignUpload(key, req.mimeType);
  return { mediaAssetId: asset!.id, upload };
}

/** Motiv anlegen: liefert eine signierte Upload-URL; die Datei geht direkt in den Speicher. */
export async function requestCreativeUpload(
  ctx: AppContext,
  actor: Actor,
  campaignId: string,
  req: UploadRequest & { title?: string },
) {
  await validateUploadRequest(ctx.sql, req);
  return ctx.sql.begin(async (tx) => {
    const campaign = await getCampaign(tx, actor, campaignId);
    if (campaign.status === "ended" || campaign.status === "cancelled") {
      throw conflict("invalid_status", "Für beendete Kampagnen können keine Motive hochgeladen werden.");
    }
    const { mediaAssetId, upload } = await createAsset(ctx, tx, "creative", campaign.customer_id, actor.userId, req);
    const { max } = one(
      await tx<
        { max: number }[]
      >`SELECT coalesce(max(sort_order), -1)::int AS max FROM creatives WHERE campaign_id = ${campaignId}`,
    );
    const [creative] = await tx<{ id: string }[]>`
      INSERT INTO creatives (campaign_id, media_asset_id, title, sort_order, created_by)
      VALUES (${campaignId}, ${mediaAssetId}, ${req.title ?? req.filename}, ${max + 1}, ${actor.userId})
      RETURNING id
    `;
    await audit(tx, actor.userId, "creative.create", "creative", creative!.id, { campaignId });
    return { creativeId: creative!.id, mediaAssetId, upload };
  });
}

export async function requestFillerUpload(ctx: AppContext, adminId: string, req: UploadRequest & { title?: string }) {
  await validateUploadRequest(ctx.sql, req);
  return ctx.sql.begin(async (tx) => {
    const { mediaAssetId, upload } = await createAsset(ctx, tx, "filler", null, adminId, req);
    const [filler] = await tx<{ id: string }[]>`
      INSERT INTO fillers (media_asset_id, title) VALUES (${mediaAssetId}, ${req.title ?? req.filename}) RETURNING id
    `;
    await audit(tx, adminId, "filler.create", "filler", filler!.id);
    return { fillerId: filler!.id, mediaAssetId, upload };
  });
}

/** Nach dem Upload: Prüfung und Umwandlung im Worker anstoßen. */
export async function completeUpload(ctx: AppContext, actor: Actor, mediaAssetId: string) {
  const [asset] = await ctx.sql<{ id: string; customer_id: string | null; status: string; original_key: string }[]>`
    SELECT id, customer_id, status, original_key FROM media_assets WHERE id = ${mediaAssetId}
  `;
  if (!asset || (actor.role === "customer" && asset.customer_id !== actor.customerId)) throw notFound("Datei nicht gefunden.");
  if (asset.status !== "awaiting_upload") throw conflict("invalid_status", "Upload wurde bereits abgeschlossen.");
  if (!(await ctx.storage.exists(asset.original_key))) throw badRequest("upload_missing", "Datei wurde noch nicht hochgeladen.");
  await ctx.sql.begin(async (tx) => {
    await tx`UPDATE media_assets SET status = 'processing' WHERE id = ${mediaAssetId}`;
    await enqueue(tx, "media.process", { mediaAssetId }, { dedupeKey: `media:${mediaAssetId}`, maxAttempts: 3 });
  });
}

// ---------------------------------------------------------------------------
// Verarbeitung (Worker)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  mediaType: "image" | "video";
  width: number;
  height: number;
  durationMs: number | null;
  formatName: string;
}

export async function probe(ffprobe: string, file: string): Promise<ProbeResult> {
  let out: string;
  try {
    ({ stdout: out } = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    throw new MediaRejected("Die Datei konnte nicht gelesen werden (kein gültiges Bild oder Video).");
  }
  const data = JSON.parse(out) as {
    format?: { format_name?: string; duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string;
      nb_frames?: string;
      codec_name?: string;
    }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new MediaRejected("Die Datei enthält kein Bild bzw. keine Videospur.");
  const formatName = data.format?.format_name ?? "";
  const imageFormats = ["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "mjpeg"];
  const isImage =
    imageFormats.some((f) => formatName.includes(f)) ||
    (["png", "mjpeg", "webp"].includes(video.codec_name ?? "") && !data.format?.duration);
  if (isImage) return { mediaType: "image", width: video.width, height: video.height, durationMs: null, formatName };
  const seconds = Number(video.duration ?? data.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaRejected("Die Videolänge konnte nicht bestimmt werden.");
  return { mediaType: "video", width: video.width, height: video.height, durationMs: Math.round(seconds * 1000), formatName };
}

/** Fehler, die dem Kunden angezeigt werden (kein erneuter Versuch). */
export class MediaRejected extends Error {}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Prüft und vereinheitlicht eine Datei für die Tablets (Galaxy Tab A9+, 1920×1200):
 * Videos -> H.264/MP4 ohne Ton, 30 fps; Bilder -> JPEG. Seitenverhältnis bleibt, Rand schwarz.
 */
export async function processMediaAsset(ctx: AppContext, mediaAssetId: string): Promise<void> {
  const [asset] = await ctx.sql<{ id: string; purpose: string; original_key: string; status: string }[]>`
    SELECT id, purpose, original_key, status FROM media_assets WHERE id = ${mediaAssetId}
  `;
  if (!asset || asset.status !== "processing") return;
  const [creative] = await ctx.sql<{ id: string; campaign_id: string; seconds_per_loop: number }[]>`
    SELECT cr.id, cr.campaign_id, c.seconds_per_loop FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id
    WHERE cr.media_asset_id = ${mediaAssetId}
  `;
  const dir = await mkdtemp(path.join(tmpdir(), "taxiads-media-"));
  try {
    const input = path.join(dir, "input");
    await ctx.storage.download(asset.original_key, input);
    const info = await probe(ctx.config.FFPROBE_PATH, input);
    const maxMs = creative ? creative.seconds_per_loop * 1000 : null;
    if (info.mediaType === "video" && maxMs !== null && info.durationMs! > maxMs + VIDEO_TOLERANCE_MS) {
      throw new MediaRejected(
        `Das Video ist ${(info.durationMs! / 1000).toFixed(1)} s lang, gebucht sind ${creative!.seconds_per_loop} s pro Durchlauf.`,
      );
    }
    const W = ctx.config.MEDIA_TARGET_WIDTH;
    const H = ctx.config.MEDIA_TARGET_HEIGHT;
    const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const ext = info.mediaType === "video" ? "mp4" : "jpg";
    const output = path.join(dir, `output.${ext}`);
    const args =
      info.mediaType === "video"
        ? [
            "-y",
            "-i",
            input,
            "-an",
            "-sn",
            "-dn",
            "-vf",
            `${fit},fps=30,format=yuv420p`,
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level",
            "4.1",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-maxrate",
            "8M",
            "-bufsize",
            "16M",
            "-movflags",
            "+faststart",
            ...(maxMs !== null ? ["-t", String(maxMs / 1000)] : []),
            output,
          ]
        : ["-y", "-i", input, "-vf", fit, "-frames:v", "1", "-q:v", "2", output];
    try {
      await run(ctx.config.FFMPEG_PATH, args, { maxBuffer: 10 * 1024 * 1024 });
    } catch (err) {
      throw new MediaRejected(
        `Die Datei konnte nicht umgewandelt werden. ${(err as Error).message.split("\n").slice(-2).join(" ")}`,
      );
    }
    const result = await probe(ctx.config.FFPROBE_PATH, output);
    const { size } = await stat(output);
    const sha256 = await sha256File(output);
    const processedKey = `processed/${asset.id}.${ext}`;
    await ctx.storage.upload(processedKey, output, info.mediaType === "video" ? "video/mp4" : "image/jpeg");
    await ctx.sql.begin(async (tx) => {
      await tx`
        UPDATE media_assets SET status = 'ready', processed_key = ${processedKey}, media_type = ${info.mediaType},
          width = ${result.width}, height = ${result.height}, duration_ms = ${result.durationMs},
          sha256 = ${sha256}, size_bytes = ${size}, error = NULL
        WHERE id = ${asset.id}
      `;
      if (creative) {
        await tx`UPDATE creatives SET status = 'pending_review' WHERE id = ${creative.id} AND status = 'processing'`;
      } else {
        await requestPlaylistRebuild(tx, "all"); // Füllinhalt fertig
      }
    });
  } catch (err) {
    if (!(err instanceof MediaRejected)) throw err; // technischer Fehler -> Job wird wiederholt
    await ctx.sql.begin(async (tx) => {
      await tx`UPDATE media_assets SET status = 'failed', error = ${err.message} WHERE id = ${asset.id}`;
      if (creative) await tx`UPDATE creatives SET status = 'failed', review_note = ${err.message} WHERE id = ${creative.id}`;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Motive: Liste, Freigabe, Archivieren
// ---------------------------------------------------------------------------

export interface CreativeRow {
  id: string;
  campaign_id: string;
  title: string;
  sort_order: number;
  status: string;
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  media_asset_id: string;
  media_type: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  size_bytes: string | null;
  original_filename: string;
  processed_key: string | null;
  media_status: string;
  seconds_per_loop: number;
}

export async function listCreatives(db: Db, campaignId: string): Promise<CreativeRow[]> {
  return db<CreativeRow[]>`
    SELECT cr.id, cr.campaign_id, cr.title, cr.sort_order, cr.status, cr.review_note, cr.reviewed_at, cr.created_at,
           m.id AS media_asset_id, m.media_type, m.width, m.height, m.duration_ms, m.size_bytes, m.original_filename,
           m.processed_key, m.status AS media_status, c.seconds_per_loop
    FROM creatives cr
    JOIN media_assets m ON m.id = cr.media_asset_id
    JOIN campaigns c ON c.id = cr.campaign_id
    WHERE cr.campaign_id = ${campaignId}
    ORDER BY cr.sort_order, cr.created_at
  `;
}

export async function serializeCreative(ctx: AppContext, c: CreativeRow) {
  return {
    id: c.id,
    campaignId: c.campaign_id,
    title: c.title,
    sortOrder: c.sort_order,
    status: c.status,
    reviewNote: c.review_note,
    reviewedAt: c.reviewed_at,
    createdAt: c.created_at,
    media: {
      id: c.media_asset_id,
      type: c.media_type,
      width: c.width,
      height: c.height,
      durationMs: c.duration_ms,
      sizeBytes: c.size_bytes === null ? null : Number(c.size_bytes),
      originalFilename: c.original_filename,
      status: c.media_status,
      previewUrl: c.processed_key ? await ctx.storage.presignDownload(c.processed_key, 3600) : null,
    },
    /** Passt das Motiv (noch) zur gebuchten Dauer? Nach Verkürzen der Sekunden ggf. nicht mehr. */
    fitsBooking: c.duration_ms === null || c.duration_ms <= c.seconds_per_loop * 1000 + VIDEO_TOLERANCE_MS,
  };
}

async function creativeForActor(db: Db, actor: Actor, creativeId: string) {
  const [row] = await db<{ id: string; campaign_id: string; customer_id: string; status: string }[]>`
    SELECT cr.id, cr.campaign_id, c.customer_id, cr.status FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id
    WHERE cr.id = ${creativeId} FOR UPDATE OF cr
  `;
  if (!row || (actor.role === "customer" && row.customer_id !== actor.customerId)) throw notFound("Motiv nicht gefunden.");
  return row;
}

async function campaignVehicles(db: Db, campaignId: string): Promise<string[]> {
  const rows = await db<{ vehicle_id: string }[]>`SELECT DISTINCT vehicle_id FROM allocations WHERE campaign_id = ${campaignId}`;
  return rows.map((r) => r.vehicle_id);
}

export async function reviewCreative(
  ctx: AppContext,
  adminId: string,
  creativeId: string,
  decision: "approved" | "rejected",
  note?: string,
) {
  await ctx.sql.begin(async (tx) => {
    const c = await creativeForActor(tx, { role: "admin", userId: adminId }, creativeId);
    if (!["pending_review", "approved", "rejected"].includes(c.status)) {
      throw conflict("invalid_status", "Dieses Motiv kann (noch) nicht geprüft werden.");
    }
    if (decision === "rejected" && !note) throw badRequest("note_required", "Bitte einen Ablehnungsgrund angeben.");
    await tx`
      UPDATE creatives SET status = ${decision}, review_note = ${note ?? null}, reviewed_by = ${adminId}, reviewed_at = now()
      WHERE id = ${creativeId}
    `;
    await audit(tx, adminId, `creative.${decision === "approved" ? "approve" : "reject"}`, "creative", creativeId, { note });
    await requestPlaylistRebuild(tx, await campaignVehicles(tx, c.campaign_id));
  });
}

export async function updateCreative(
  ctx: AppContext,
  actor: Actor,
  creativeId: string,
  patch: { title?: string; sortOrder?: number; archived?: boolean },
) {
  await ctx.sql.begin(async (tx) => {
    const c = await creativeForActor(tx, actor, creativeId);
    if (patch.title !== undefined) await tx`UPDATE creatives SET title = ${patch.title} WHERE id = ${creativeId}`;
    if (patch.sortOrder !== undefined) await tx`UPDATE creatives SET sort_order = ${patch.sortOrder} WHERE id = ${creativeId}`;
    if (patch.archived === true) await tx`UPDATE creatives SET status = 'archived' WHERE id = ${creativeId}`;
    await audit(tx, actor.userId, "creative.update", "creative", creativeId, { ...patch });
    await requestPlaylistRebuild(tx, await campaignVehicles(tx, c.campaign_id));
  });
}
