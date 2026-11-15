// Shared test setup: a fake S3, an S3 client and a tus server, all on local ports, data under .tmp/.
import { request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeS3 } from "../src/testing/fakes3.js";
import { S3Client } from "../src/s3.js";
import { startServer, type RunningServer, type TusOptions } from "../src/server.js";
import { UploadStore } from "../src/store.js";

export const KIB = 1024;
export const CREDS = { accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-only-secret-not-a-real-key" };
export const BUCKET = "uploads-test";

/** A fresh scratch directory path under the repository's .tmp/. */
export function scratch(): string {
  return join(process.cwd(), ".tmp", `t-${randomBytes(6).toString("hex")}`);
}

/** Hex SHA-256 of a buffer. */
export function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface Rig {
  dir: string;
  fake: FakeS3;
  s3: S3Client;
  store: UploadStore;
  server: RunningServer;
  /** Creation URL (…/files). */
  files: string;
  errors: unknown[];
  /** Resolves with the offset when the next PATCH on `id` has finished. */
  patchEnd(id: string): Promise<number>;
  /** Starts a second server on the same state and S3 (a restart). */
  restart(): Promise<RunningServer>;
  close(): Promise<void>;
}

/** Starts fake S3 + tus server with small parts (64 KiB) so tests stay small. */
export async function rig(over: Partial<TusOptions> = {}, s3Over: { maxAttempts?: number; timeoutMs?: number } = {}): Promise<Rig> {
  const dir = scratch();
  const fake = new FakeS3({ dir: join(dir, "s3"), bucket: BUCKET, credentials: CREDS, minPartSize: 64 * KIB });
  const endpoint = await fake.start();
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    credentials: CREDS,
    backoffMs: 5,
    timeoutMs: s3Over.timeoutMs ?? 5_000,
    maxAttempts: s3Over.maxAttempts ?? 3,
  });
  const store = new UploadStore(join(dir, "state"));
  const waiters = new Map<string, ((offset: number) => void)[]>();
  const errors: unknown[] = [];
  const opts: TusOptions = {
    s3,
    store,
    partSize: 64 * KIB,
    maxSize: 4 * 1024 * KIB,
    onPatchEnd: (id, offset) => {
      const list = waiters.get(id) ?? [];
      waiters.delete(id);
      for (const w of list) w(offset);
    },
    logError: (_msg, err) => errors.push(err),
    ...over,
  };
  const server = await startServer(opts);
  const extra: RunningServer[] = [];
  return {
    dir,
    fake,
    s3,
    store,
    server,
    files: `${server.url}/files`,
    errors,
    patchEnd: (id) =>
      new Promise((resolve) => {
        waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
      }),
    restart: async () => {
      const again = await startServer(opts);
      extra.push(again);
      return again;
    },
    close: async () => {
      for (const s of extra) await s.close();
      await server.close();
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** Sends one tus request (Tus-Resumable 1.0.0 unless overridden) and reads the whole answer. */
export function tus(method: string, url: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const all: Record<string, string> = { "Tus-Resumable": "1.0.0", ...headers };
    for (const [k, v] of Object.entries(all)) if (v === "") delete all[k];
    if (body !== undefined && all["Content-Length"] === undefined) all["Content-Length"] = String(body.length);
    const req = request(url, { method, headers: all, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Creates an upload and returns its absolute URL and id. */
export async function create(r: Rig, length: number, headers: Record<string, string> = {}): Promise<{ url: string; id: string }> {
  const res = await tus("POST", r.files, { "Upload-Length": String(length), ...headers });
  if (res.status !== 201) throw new Error(`create: ${res.status} ${res.text}`);
  const location = String(res.headers["location"]);
  return { url: new URL(location, r.server.url).toString(), id: location.split("/").pop() ?? "" };
}

/** PATCHes bytes at an offset. */
export function patch(url: string, offset: number, body: Buffer, headers: Record<string, string> = {}): Promise<Res> {
  return tus("PATCH", url, { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset), ...headers }, body);
}

/** Reads the server's offset with HEAD. */
export async function offset(url: string): Promise<number> {
  const res = await tus("HEAD", url);
  if (res.status !== 200) throw new Error(`HEAD ${res.status}`);
  return Number(res.headers["upload-offset"]);
}

/** Polls a condition every 10 ms until it holds (or fails after `ms`). */
export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
