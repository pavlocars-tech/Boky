import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config";
import { hmac, safeEqual } from "./crypto";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Objektspeicher für Medien. In Produktion S3-kompatibel (EU-Region),
 * in Entwicklung und Tests ein lokales Verzeichnis mit signierten URLs.
 */
export interface Storage {
  presignUpload(key: string, contentType: string, expiresSeconds?: number): Promise<PresignedUpload>;
  presignDownload(key: string, expiresSeconds?: number): Promise<string>;
  download(key: string, filePath: string): Promise<void>;
  upload(key: string, filePath: string, contentType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

export class S3Storage implements Storage {
  private client: S3Client;
  /** Signiert URLs mit der öffentlich erreichbaren Adresse. */
  private publicClient: S3Client;
  constructor(private config: Config) {
    const make = (endpoint: string | undefined) =>
      new S3Client({
        region: config.S3_REGION,
        endpoint,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials:
          config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
    this.client = make(config.S3_ENDPOINT);
    this.publicClient = config.S3_PUBLIC_ENDPOINT ? make(config.S3_PUBLIC_ENDPOINT) : this.client;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.S3_BUCKET }));
    }
  }

  async presignUpload(key: string, contentType: string, expiresSeconds = 900): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: expiresSeconds },
    );
    return {
      url,
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
    };
  }

  presignDownload(key: string, expiresSeconds = 900): Promise<string> {
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), {
      expiresIn: expiresSeconds,
    });
  }

  async download(key: string, filePath: string): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
    await pipeline(res.Body as Readable, createWriteStream(filePath));
  }

  async upload(key: string, filePath: string, contentType: string): Promise<void> {
    const { size } = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
        ContentLength: size,
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
  }
}

/** Lokaler Speicher; Up- und Downloads laufen über die Route `/files/*` der API. */
export class LocalStorage implements Storage {
  constructor(
    private baseDir: string,
    private publicUrl: string,
    private secret: string,
  ) {}

  filePath(key: string): string {
    const resolved = path.resolve(this.baseDir, key);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) throw new Error("Ungültiger Schlüssel");
    return resolved;
  }

  sign(op: "get" | "put", key: string, exp: number): string {
    return hmac(this.secret, `${op}:${key}:${exp}`);
  }

  verify(op: "get" | "put", key: string, exp: number, sig: string): boolean {
    return exp * 1000 > Date.now() && safeEqual(this.sign(op, key, exp), sig);
  }

  private url(op: "get" | "put", key: string, expiresSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + expiresSeconds;
    const q = new URLSearchParams({ op, exp: String(exp), sig: this.sign(op, key, exp) });
    return `${this.publicUrl}/files/${key}?${q}`;
  }

  async presignUpload(key: string, contentType: string, expiresSeconds = 900): Promise<PresignedUpload> {
    return {
      url: this.url("put", key, expiresSeconds),
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
    };
  }

  async presignDownload(key: string, expiresSeconds = 900): Promise<string> {
    return this.url("get", key, expiresSeconds);
  }

  async write(key: string, body: Readable, maxBytes: number): Promise<number> {
    const target = this.filePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) body.destroy(new Error("Datei zu groß"));
    });
    try {
      await pipeline(body, createWriteStream(target));
    } catch (err) {
      await rm(target, { force: true });
      throw err;
    }
    return size;
  }

  async download(key: string, filePath: string): Promise<void> {
    await pipeline(createReadStream(this.filePath(key)), createWriteStream(filePath));
  }

  async upload(key: string, filePath: string): Promise<void> {
    const target = this.filePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(createReadStream(filePath), createWriteStream(target));
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.filePath(key)).then(
      () => true,
      () => false,
    );
  }

  async remove(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }
}

export function createStorage(config: Config): Storage {
  if (config.STORAGE_DRIVER === "s3") return new S3Storage(config);
  return new LocalStorage(path.resolve(config.LOCAL_STORAGE_DIR), config.PUBLIC_API_URL, config.APP_SECRET);
}
