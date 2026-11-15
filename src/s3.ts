// Minimal S3 client for multipart uploads: SigV4 signing, timeouts and bounded retries.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { amzDate, canonicalQuery, EMPTY_SHA256, sha256Hex, sign, uriEncode, type Credentials } from "./sigv4.js";

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  /** Path-style URLs (`endpoint/bucket/key`), as MinIO and most S3-compatible stores expect. */
  forcePathStyle?: boolean;
  /** Deadline for one HTTP attempt, in milliseconds. */
  timeoutMs?: number;
  /** Attempts per operation (1 = no retry). */
  maxAttempts?: number;
  /** First backoff delay in milliseconds; doubles per attempt, with jitter. */
  backoffMs?: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/** An error answer from S3 (or a transport failure, status 0). */
export class S3Error extends Error {
  /** Builds an S3 error with HTTP status and S3 error code. */
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "S3Error";
  }

  /** Whether a retry can succeed (transport errors, throttling and 5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

interface Resp {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** XML text escaping for request bodies. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** XML entity decoding for the few entities S3 emits. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

/** First text value of an XML element, or undefined. */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m?.[1] === undefined ? undefined : xmlUnescape(m[1]);
}

/** S3 client restricted to the calls this service needs. */
export class S3Client {
  private readonly base: URL;
  private readonly opts: Required<Omit<S3Options, "endpoint">>;

  /** Validates options and fills defaults. */
  constructor(options: S3Options) {
    this.base = new URL(options.endpoint);
    if (this.base.protocol !== "http:" && this.base.protocol !== "https:") {
      throw new Error("S3 endpoint must be http(s)");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error("invalid S3 bucket name");
    }
    this.opts = {
      region: options.region,
      bucket: options.bucket,
      credentials: options.credentials,
      forcePathStyle: options.forcePathStyle ?? true,
      timeoutMs: options.timeoutMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 3,
      backoffMs: options.backoffMs ?? 200,
    };
    if (this.opts.maxAttempts < 1 || this.opts.timeoutMs <= 0) {
      throw new Error("maxAttempts must be >= 1 and timeoutMs > 0");
    }
  }

  /** Starts a multipart upload and returns its UploadId. */
  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) headers["content-type"] = contentType;
    const res = await this.call("POST", key, [["uploads", ""]], headers, undefined);
    const id = xmlTag(res.body.toString("utf8"), "UploadId");
    if (id === undefined || id === "") throw new S3Error("CreateMultipartUpload: no UploadId", res.status, "BadResponse");
    return id;
  }

  /** Uploads one part (idempotent: the same part number overwrites) and returns its ETag. */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new RangeError("partNumber must be 1..10000");
    }
    const res = await this.call(
      "PUT",
      key,
      [
        ["partNumber", String(partNumber)],
        ["uploadId", uploadId],
      ],
      {},
      body,
    );
    const etag = res.headers.etag;
    if (typeof etag !== "string" || etag === "") throw new S3Error("UploadPart: no ETag", res.status, "BadResponse");
    return etag;
  }

  /** Completes a multipart upload; a retry after a lost success is detected and treated as done. */
  async completeMultipartUpload(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    try {
      await this.call("POST", key, [["uploadId", uploadId]], { "content-type": "application/xml" }, Buffer.from(xml));
    } catch (err) {
      // A retried Complete whose first attempt succeeded answers NoSuchUpload; the object then exists.
      if (err instanceof S3Error && err.code === "NoSuchUpload" && (await this.headObject(key)) !== undefined) return;
      throw err;
    }
  }

  /** Aborts a multipart upload; an upload that is already gone counts as aborted. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.call("DELETE", key, [["uploadId", uploadId]], {}, undefined);
    } catch (err) {
      if (err instanceof S3Error && err.code === "NoSuchUpload") return;
      throw err;
    }
  }

  /** Writes a whole (small) object in one request. */
  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) headers["content-type"] = contentType;
    await this.call("PUT", key, [], headers, body);
  }

  /** Creates the bucket (used by the end-to-end check against a fresh S3-compatible server). */
  async createBucket(): Promise<void> {
    try {
      await this.call("PUT", "", [], {}, undefined);
    } catch (err) {
      if (err instanceof S3Error && (err.code === "BucketAlreadyOwnedByYou" || err.code === "BucketAlreadyExists")) return;
      throw err;
    }
  }

  /** Deletes an object (S3 answers 204 whether or not it existed). */
  async deleteObject(key: string): Promise<void> {
    await this.call("DELETE", key, [], {}, undefined);
  }

  /** Object size in bytes, or undefined when the object does not exist. */
  async headObject(key: string): Promise<number | undefined> {
    try {
      const res = await this.call("HEAD", key, [], {}, undefined);
      return Number(res.headers["content-length"] ?? "0");
    } catch (err) {
      if (err instanceof S3Error && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Streams an object and returns its size and SHA-256 (used to verify uploads end to end). */
  async objectDigest(key: string): Promise<{ size: number; sha256: string }> {
    const { url, headers } = this.signed("GET", key, [], {}, EMPTY_SHA256);
    const res = (await this.send(url, "GET", headers, undefined, true)) as { status: number; stream: IncomingMessage };
    if (res.status !== 200) {
      res.stream.resume();
      throw new S3Error(`GetObject ${res.status}`, res.status, "GetFailed");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of res.stream as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { size, sha256: hash.digest("hex") };
  }

  /** Runs one signed operation with bounded, backed-off retries. */
  private async call(
    method: string,
    key: string,
    query: ReadonlyArray<readonly [string, string]>,
    extra: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<Resp> {
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);
    let lastErr: S3Error | undefined;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = this.opts.backoffMs * 2 ** (attempt - 2);
        await sleep(delay / 2 + Math.random() * (delay / 2));
      }
      try {
        // Signed per attempt so x-amz-date stays fresh.
        const { url, headers } = this.signed(method, key, query, extra, payloadHash);
        const res = (await this.send(url, method, headers, body, false)) as Resp;
        const text = res.body.toString("utf8");
        // CompleteMultipartUpload can answer 200 with an <Error> body.
        if (res.status >= 300 || (res.status === 200 && text.includes("<Error>"))) {
          const status = res.status >= 300 ? res.status : 500;
          throw new S3Error(
            `${method} ${key}: ${xmlTag(text, "Message") ?? `HTTP ${res.status}`}`,
            status,
            xmlTag(text, "Code") ?? (status === 404 ? "NotFound" : "HttpError"),
          );
        }
        return res;
      } catch (err) {
        const e = err instanceof S3Error ? err : new S3Error(`${method} ${key}: ${String(err)}`, 0, "TransportError");
        if (!e.retryable) throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? new S3Error("no attempt made", 0, "TransportError");
  }

  /** Builds the URL and signed headers for a request. */
  private signed(
    method: string,
    key: string,
    query: ReadonlyArray<readonly [string, string]>,
    extra: Record<string, string>,
    payloadHash: string,
  ): { url: URL; headers: Record<string, string> } {
    const encodedKey = uriEncode(key, true);
    const basePath = this.base.pathname.replace(/\/$/, "");
    let host = this.base.host;
    let path: string;
    if (this.opts.forcePathStyle) {
      path = `${basePath}/${this.opts.bucket}/${encodedKey}`;
    } else {
      host = `${this.opts.bucket}.${this.base.host}`;
      path = `${basePath}/${encodedKey}`;
    }
    const qs = canonicalQuery(query);
    const url = new URL(`${this.base.protocol}//${host}${path}${qs === "" ? "" : "?" + qs}`);
    const headers: Record<string, string> = {
      ...extra,
      host,
      "x-amz-date": amzDate(new Date()),
      "x-amz-content-sha256": payloadHash,
    };
    const { authorization } = sign({
      method,
      path,
      query,
      headers,
      payloadHash,
      region: this.opts.region,
      service: "s3",
      credentials: this.opts.credentials,
    });
    return { url, headers: { ...headers, authorization } };
  }

  /** One HTTP exchange with a deadline; buffers small responses or hands back the stream. */
  private send(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    stream: boolean,
  ): Promise<Resp | { status: number; stream: IncomingMessage }> {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    const sendHeaders = { ...headers, "content-length": String(body?.length ?? 0) };
    return new Promise((resolve, reject) => {
      const req = requester(url, { method, headers: sendHeaders, signal }, (res) => {
        if (stream) {
          resolve({ status: res.statusCode ?? 0, stream: res });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy(new Error("S3 response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
  }
}
