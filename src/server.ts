// tus 1.0.0 server (core, creation, termination) that streams PATCH bodies into S3 multipart parts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  contentTypeFrom,
  formatMetadata,
  OFFSET_CONTENT_TYPE,
  parseMetadata,
  parseNonNegativeInt,
  TUS_EXTENSIONS,
  TUS_VERSION,
  UPLOAD_ID,
} from "./protocol.js";
import { S3Error, type S3Client } from "./s3.js";
import { offsetOf, type UploadInfo, type UploadStore } from "./store.js";

export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export interface TusOptions {
  s3: S3Client;
  store: UploadStore;
  /** Bytes per S3 part; every part but the last has exactly this size. */
  partSize: number;
  /** Largest Upload-Length accepted. */
  maxSize: number;
  /** URL path the uploads live under, e.g. "/files". */
  basePath?: string;
  /** S3 key prefix for uploaded objects. */
  keyPrefix?: string;
  /** A PATCH that sends nothing for this long is cut off (its bytes so far are kept). */
  idleTimeoutMs?: number;
  /** PATCH requests running at once (each holds one part buffer); more get 503. */
  maxConcurrentPatches?: number;
  /** How long HEAD waits for a running PATCH to save its bytes before answering. */
  lockWaitMs?: number;
  /** Browser origins allowed by CORS; empty means no CORS headers. */
  allowedOrigins?: readonly string[];
  /** Called when a PATCH has finished and its state is saved (logs, tests). */
  onPatchEnd?: (id: string, offset: number, error: unknown) => void;
  /** Error log; defaults to stderr. */
  logError?: (msg: string, err: unknown) => void;
}

/** An error answered to the client with a status code. */
class HttpError extends Error {
  /** Builds an error with an HTTP status. */
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const EXPOSED = "Location,Upload-Offset,Upload-Length,Upload-Metadata,Tus-Resumable,Tus-Version,Tus-Extension,Tus-Max-Size";
const ALLOWED_HEADERS =
  "Content-Type,Upload-Offset,Upload-Length,Upload-Metadata,Upload-Defer-Length,Tus-Resumable,X-Requested-With";

/** Request handler implementing the tus protocol on top of S3 multipart uploads. */
export class TusHandler {
  private readonly basePath: string;
  private readonly keyPrefix: string;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentPatches: number;
  private readonly lockWaitMs: number;
  private readonly locks = new Set<string>();
  private readonly unlockWaiters = new Map<string, (() => void)[]>();
  private activePatches = 0;

  /** Validates options. */
  constructor(private readonly opts: TusOptions) {
    if (!Number.isSafeInteger(opts.partSize) || opts.partSize < 1) throw new RangeError("partSize must be a positive integer");
    if (!Number.isSafeInteger(opts.maxSize) || opts.maxSize < 0) throw new RangeError("maxSize must be a non-negative integer");
    this.basePath = (opts.basePath ?? "/files").replace(/\/+$/, "");
    this.keyPrefix = opts.keyPrefix ?? "uploads/";
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.maxConcurrentPatches = opts.maxConcurrentPatches ?? 16;
    this.lockWaitMs = opts.lockWaitMs ?? 3_000;
  }

  /** Node request listener. */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    this.route(req, res).catch((err: unknown) => {
      // An unread body means the connection cannot be reused.
      if (!req.complete && !res.headersSent) res.setHeader("Connection", "close");
      if (err instanceof HttpError) {
        this.reply(res, err.status, err.headers, err.message);
        return;
      }
      if (err instanceof S3Error) {
        this.log("storage error", err);
        this.reply(res, err.retryable ? 503 : 502, err.retryable ? { "Retry-After": "1" } : {}, "storage unavailable");
        return;
      }
      this.log("unexpected error", err);
      this.reply(res, 500, {}, "internal error");
    });
  };

  /** Dispatches by method and path. */
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Tus-Resumable", TUS_VERSION);
    this.cors(req, res);
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    let id: string | undefined;
    if (path === this.basePath || path === this.basePath + "/") {
      id = undefined;
    } else if (path.startsWith(this.basePath + "/")) {
      id = path.slice(this.basePath.length + 1);
      if (!UPLOAD_ID.test(id)) throw new HttpError(404, "upload not found");
    } else {
      throw new HttpError(404, "not found");
    }
    const method = req.method ?? "GET";
    if (method === "OPTIONS") return this.options(res);
    if (req.headers["tus-resumable"] !== TUS_VERSION) {
      throw new HttpError(412, "Tus-Resumable 1.0.0 required", { "Tus-Version": TUS_VERSION });
    }
    if (id === undefined) {
      if (method === "POST") return this.create(req, res);
      throw new HttpError(405, "method not allowed", { Allow: "OPTIONS, POST" });
    }
    switch (method) {
      case "HEAD":
        return this.head(id, res);
      case "PATCH":
        return this.patch(id, req, res);
      case "DELETE":
        return this.terminate(id, res);
      default:
        throw new HttpError(405, "method not allowed", { Allow: "OPTIONS, HEAD, PATCH, DELETE" });
    }
  }

  /** OPTIONS: server capabilities (and CORS preflight). */
  private options(res: ServerResponse): void {
    this.reply(res, 204, {
      "Tus-Version": TUS_VERSION,
      "Tus-Extension": TUS_EXTENSIONS,
      "Tus-Max-Size": String(this.opts.maxSize),
    });
  }

  /** POST: creates an upload and its S3 multipart upload. */
  private async create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers["upload-defer-length"] !== undefined) throw new HttpError(400, "Upload-Defer-Length is not supported");
    const length = parseNonNegativeInt(header(req, "upload-length"));
    if (length === undefined) throw new HttpError(400, "Upload-Length must be a non-negative integer");
    if (length > this.opts.maxSize) throw new HttpError(413, `Upload-Length exceeds ${this.opts.maxSize}`);
    if (Math.ceil(length / this.opts.partSize) > MAX_PARTS) throw new HttpError(413, "upload needs more than 10000 parts");
    const declared = parseNonNegativeInt(header(req, "content-length"));
    if ((declared !== undefined && declared > 0) || req.headers["transfer-encoding"] !== undefined) {
      throw new HttpError(400, "creation-with-upload is not supported; send the data with PATCH");
    }
    const metadata = parseMetadata(header(req, "upload-metadata"));
    if (typeof metadata === "string") throw new HttpError(400, metadata);
    const id = randomUUID();
    const key = this.keyPrefix + id;
    const contentType = contentTypeFrom(metadata);
    const info: UploadInfo = {
      id,
      length,
      metadata,
      key,
      s3UploadId: "",
      parts: [],
      spoolSize: 0,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    if (length === 0) {
      // S3 multipart needs at least one part; an empty object is a single PutObject.
      await this.opts.s3.putObject(key, Buffer.alloc(0), contentType);
      info.completed = true;
    } else {
      info.s3UploadId = await this.opts.s3.createMultipartUpload(key, contentType);
    }
    await this.opts.store.save(info);
    this.reply(res, 201, { Location: `${this.basePath}/${id}` });
  }

  /** HEAD: the offset to resume from (waits briefly for a PATCH that is still saving). */
  private async head(id: string, res: ServerResponse): Promise<void> {
    await this.waitUnlocked(id, this.lockWaitMs);
    const info = await this.mustLoad(id);
    const headers: Record<string, string> = {
      "Upload-Offset": String(offsetOf(info)),
      "Upload-Length": String(info.length),
      "Cache-Control": "no-store",
    };
    if (Object.keys(info.metadata).length > 0) headers["Upload-Metadata"] = formatMetadata(info.metadata);
    this.reply(res, 200, headers);
  }

  /** PATCH: appends the body at Upload-Offset, flushing full parts to S3 as they fill. */
  private async patch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctype = (header(req, "content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (ctype !== OFFSET_CONTENT_TYPE) throw new HttpError(415, `Content-Type must be ${OFFSET_CONTENT_TYPE}`);
    const clientOffset = parseNonNegativeInt(header(req, "upload-offset"));
    if (clientOffset === undefined) throw new HttpError(400, "Upload-Offset must be a non-negative integer");
    if (this.locks.has(id)) throw new HttpError(423, "upload is busy with another request", { "Retry-After": "1" });
    if (this.activePatches >= this.maxConcurrentPatches) {
      throw new HttpError(503, "too many uploads in progress", { "Retry-After": "1" });
    }
    this.locks.add(id);
    this.activePatches++;
    let outcome: unknown;
    let offset = clientOffset;
    let info: UploadInfo | undefined;
    try {
      info = await this.mustLoad(id);
      offset = offsetOf(info);
      if (clientOffset !== offset) throw new HttpError(409, `Upload-Offset is ${offset}`, { "Upload-Offset": String(offset) });
      const declared = parseNonNegativeInt(header(req, "content-length"));
      if (declared !== undefined && offset + declared > info.length) throw new HttpError(413, "body goes past Upload-Length");
      const excess = await this.receive(info, req);
      offset = offsetOf(info);
      if (excess) throw new HttpError(413, "body goes past Upload-Length", { "Upload-Offset": String(offset) });
      this.reply(res, 204, { "Upload-Offset": String(offset) });
    } catch (err) {
      outcome = err;
      throw err;
    } finally {
      // Report what is durably stored, also when the request failed part-way.
      if (info !== undefined) offset = offsetOf(info);
      this.unlock(id);
      this.activePatches--;
      this.opts.onPatchEnd?.(id, offset, outcome);
    }
  }

  /** Streams the body into part-sized buffers; keeps every received byte even if the client drops. */
  private async receive(info: UploadInfo, req: IncomingMessage): Promise<boolean> {
    const { s3, store, partSize } = this.opts;
    const part = Buffer.allocUnsafe(Math.min(partSize, info.length));
    let fill = info.spoolSize;
    let uploaded = offsetOf(info) - info.spoolSize;
    if (fill > 0) (await store.readSpool(info.id, fill)).copy(part, 0);
    let excess = false;
    let streamError: unknown;

    // Sends the buffered bytes as the next part and records it before anything else happens.
    const flush = async (): Promise<void> => {
      const partNumber = info.parts.length + 1;
      const etag = await s3.uploadPart(info.key, info.s3UploadId, partNumber, part.subarray(0, fill));
      info.parts.push({ partNumber, etag, size: fill });
      info.spoolSize = 0;
      uploaded += fill;
      fill = 0;
      await store.save(info);
      await store.dropSpool(info.id);
    };

    req.setTimeout(this.idleTimeoutMs, () => req.destroy(new Error("idle timeout")));
    let flushing = false;
    try {
      if (!info.completed) {
        try {
          // destroyOnReturn: false keeps the socket open so an error answer can still be sent.
          for await (const raw of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
            let chunk = raw;
            const room = info.length - uploaded - fill;
            if (chunk.length > room) {
              excess = true;
              chunk = chunk.subarray(0, room);
            }
            while (chunk.length > 0) {
              const n = Math.min(chunk.length, partSize - fill);
              chunk.copy(part, fill, 0, n);
              fill += n;
              chunk = chunk.subarray(n);
              if (fill === partSize) {
                flushing = true;
                await flush();
                flushing = false;
              }
            }
            if (excess) break;
          }
        } catch (err) {
          if (flushing) throw err;
          // The client went away or stalled: keep what arrived so it can resume from there.
          streamError = err;
        }
      }
      if (!info.completed && uploaded + fill === info.length) {
        if (fill > 0) await flush();
        await s3.completeMultipartUpload(
          info.key,
          info.s3UploadId,
          info.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
        );
        info.completed = true;
        await store.save(info);
      }
    } finally {
      if (fill > 0 && fill !== info.spoolSize) {
        // Unfinished part (or a part S3 refused): spool it so the offset counts these bytes.
        await store.writeSpool(info.id, part.subarray(0, fill));
        info.spoolSize = fill;
        await store.save(info);
      }
    }
    if (streamError !== undefined) throw new HttpError(400, `upload interrupted: ${String(streamError)}`);
    return excess;
  }

  /** DELETE: aborts the multipart upload (or deletes the finished object) and forgets the upload. */
  private async terminate(id: string, res: ServerResponse): Promise<void> {
    if (this.locks.has(id)) throw new HttpError(423, "upload is busy with another request", { "Retry-After": "1" });
    this.locks.add(id);
    try {
      const info = await this.mustLoad(id);
      if (info.completed) await this.opts.s3.deleteObject(info.key);
      else await this.opts.s3.abortMultipartUpload(info.key, info.s3UploadId);
      await this.opts.store.remove(id);
      this.reply(res, 204, {});
    } finally {
      this.unlock(id);
    }
  }

  /** Releases an upload's lock and wakes requests waiting for it. */
  private unlock(id: string): void {
    this.locks.delete(id);
    const waiters = this.unlockWaiters.get(id) ?? [];
    this.unlockWaiters.delete(id);
    for (const w of waiters) w();
  }

  /** Resolves when the upload is not locked, or after `ms` (whichever is first). */
  private async waitUnlocked(id: string, ms: number): Promise<void> {
    if (!this.locks.has(id)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.unlockWaiters.set(id, [
        ...(this.unlockWaiters.get(id) ?? []),
        () => {
          clearTimeout(timer);
          resolve();
        },
      ]);
    });
  }

  /** Loads an upload or answers 404. */
  private async mustLoad(id: string): Promise<UploadInfo> {
    const info = await this.opts.store.load(id);
    if (info === undefined) throw new HttpError(404, "upload not found");
    return info;
  }

  /** CORS headers for allowed browser origins. */
  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin === undefined || !(this.opts.allowedOrigins ?? []).includes(origin)) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", EXPOSED);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, HEAD, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }

  /** Sends a response unless the socket is already gone. */
  private reply(res: ServerResponse, status: number, headers: Record<string, string>, text?: string): void {
    if (res.headersSent || res.destroyed) return;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (text !== undefined && status >= 400) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.writeHead(status).end(text + "\n");
    } else {
      res.writeHead(status).end();
    }
  }

  /** Writes an error line (UTC timestamp) to the configured log. */
  private log(msg: string, err: unknown): void {
    if (this.opts.logError) this.opts.logError(msg, err);
    else console.error(`${new Date().toISOString()} ${msg}: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

/** One header value as a string (first value if repeated). */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Starts an HTTP server for the handler on host:port (port 0 picks a free one). */
export async function startServer(opts: TusOptions, host = "127.0.0.1", port = 0): Promise<RunningServer> {
  await opts.store.init();
  const handler = new TusHandler(opts);
  const server = createServer(handler.handle);
  // Uploads may run for hours, so there is no total request deadline; stalls are cut by the idle timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    server,
    url: `http://${shownHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
