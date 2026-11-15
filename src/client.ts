// Small tus client for Node.js: creates an upload, sends chunks, and resumes from HEAD after a failure.
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { formatMetadata, OFFSET_CONTENT_TYPE, TUS_VERSION } from "./protocol.js";

/** Random access to the bytes being uploaded. */
export interface Source {
  size: number;
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Buffer>;
}

export interface UploadOptions {
  /** Creation URL, e.g. http://127.0.0.1:8080/files */
  endpoint: string;
  source: Source;
  metadata?: Record<string, string>;
  /** Bytes per PATCH request. */
  chunkSize?: number;
  /** Consecutive failed attempts allowed before giving up (reset after progress). */
  maxRetries?: number;
  backoffMs?: number;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Resume an existing upload instead of creating one. */
  uploadUrl?: string;
  onProgress?: (offset: number, size: number) => void;
}

export interface UploadResult {
  url: string;
  /** Number of times the client had to ask for the offset and resume. */
  resumes: number;
}

/** A Source over an in-memory buffer. */
export function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: (start, end) => Promise.resolve(buf.subarray(start, end)) };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
}

/** One HTTP request with a deadline; the response body is drained and discarded. */
function send(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number): Promise<Reply> {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requester(
      url,
      { method, headers: { ...headers, "Tus-Resumable": TUS_VERSION }, signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Uploads a source with the tus protocol, resuming after dropped connections. */
export async function upload(opts: UploadOptions): Promise<UploadResult> {
  const chunkSize = opts.chunkSize ?? 4 * 1024 * 1024;
  const maxRetries = opts.maxRetries ?? 5;
  const backoffMs = opts.backoffMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (chunkSize < 1) throw new RangeError("chunkSize must be positive");

  let url: URL;
  if (opts.uploadUrl !== undefined) {
    url = new URL(opts.uploadUrl);
  } else {
    const headers: Record<string, string> = { "Upload-Length": String(opts.source.size) };
    if (opts.metadata) headers["Upload-Metadata"] = formatMetadata(opts.metadata);
    const created = await send(new URL(opts.endpoint), "POST", headers, undefined, timeoutMs);
    const location = created.headers.location;
    if (created.status !== 201 || location === undefined) throw new Error(`create failed: HTTP ${created.status}`);
    url = new URL(location, opts.endpoint);
  }

  let offset = await currentOffset(url, timeoutMs);
  let failures = 0;
  let resumes = 0;
  while (offset < opts.source.size) {
    const end = Math.min(offset + chunkSize, opts.source.size);
    try {
      const chunk = await opts.source.read(offset, end);
      if (chunk.length !== end - offset) throw new Error(`source returned ${chunk.length} bytes, expected ${end - offset}`);
      const res = await send(
        url,
        "PATCH",
        { "Content-Type": OFFSET_CONTENT_TYPE, "Upload-Offset": String(offset), "Content-Length": String(chunk.length) },
        chunk,
        timeoutMs,
      );
      if (res.status !== 204) throw new Error(`PATCH failed: HTTP ${res.status}`);
      const next = Number(res.headers["upload-offset"]);
      if (!Number.isSafeInteger(next) || next < offset) throw new Error("server sent an invalid Upload-Offset");
      offset = next;
      failures = 0;
      opts.onProgress?.(offset, opts.source.size);
    } catch (err) {
      failures++;
      if (failures > maxRetries) throw new Error(`upload failed after ${maxRetries} retries: ${String(err)}`, { cause: err });
      await sleep(backoffMs * 2 ** (failures - 1));
      // Ask the server how much it kept, then continue from there.
      try {
        offset = await currentOffset(url, timeoutMs);
        resumes++;
      } catch {
        // The HEAD failed too: retry the PATCH at the last known offset; a 409 there counts as a failure.
        continue;
      }
    }
  }
  return { url: url.toString(), resumes };
}

/** HEAD request: the server's Upload-Offset for an upload. */
export async function currentOffset(url: URL, timeoutMs = 60_000): Promise<number> {
  const res = await send(url, "HEAD", {}, undefined, timeoutMs);
  if (res.status !== 200) throw new Error(`HEAD failed: HTTP ${res.status}`);
  const offset = Number(res.headers["upload-offset"]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("server sent an invalid Upload-Offset");
  return offset;
}
