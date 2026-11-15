// In-process S3 stand-in for tests and the local benchmark: checks SigV4 signatures and multipart
// rules (part order, ETags, minimum part size) and streams bodies to files under a scratch directory.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { sign, type Credentials } from "../sigv4.js";

interface Part {
  etag: string;
  size: number;
  file: string;
}

interface Upload {
  key: string;
  parts: Map<number, Part>;
}

interface FakeS3Options {
  dir: string;
  bucket: string;
  credentials: Credentials;
  region?: string;
  minPartSize?: number;
}

/** Fake S3 server with fault injection. */
export class FakeS3 {
  readonly uploads = new Map<string, Upload>();
  readonly objects = new Map<string, { file: string; size: number; sha256: string; contentType?: string }>();
  /** Sizes of every UploadPart body received, in order. */
  readonly partSizes: number[] = [];
  requests = 0;
  /** Largest number of requests handled at the same moment. */
  peakConcurrent = 0;
  private active = 0;
  private failQueue: { status: number; code: string }[] = [];
  private dropAfter = 0;
  private dropBefore = 0;
  private dropComplete = 0;
  private stall = 0;
  private url = "";
  private readonly server = createServer((req, res) => {
    this.handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) this.error(res, 500, "InternalError", String(err));
    });
  });

  /** Creates the fake (call start() next). */
  constructor(private readonly opts: FakeS3Options) {}

  /** Starts listening on a free local port; returns the endpoint URL. */
  async start(): Promise<string> {
    await mkdir(this.opts.dir, { recursive: true });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  /** Stops the server and deletes every stored byte. */
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.opts.dir, { recursive: true, force: true });
  }

  /** The next `count` requests fail with the given status and S3 error code. */
  failNext(count: number, status = 503, code = "SlowDown"): void {
    for (let i = 0; i < count; i++) this.failQueue.push({ status, code });
  }

  /** The next `count` requests are carried out, then the connection is cut before the answer. */
  dropResponseNext(count: number): void {
    this.dropAfter += count;
  }

  /** The next `count` CompleteMultipartUpload calls succeed but their answers are lost. */
  dropCompleteResponseNext(count: number): void {
    this.dropComplete += count;
  }

  /** The next `count` requests are read and never answered (the client must time out). */
  stallNext(count: number): void {
    this.stall += count;
  }

  /** The next `count` requests are cut before they are carried out. */
  dropRequestNext(count: number): void {
    this.dropBefore += count;
  }

  /** Request handler. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    this.active++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.active);
    try {
      await this.dispatch(req, res);
    } finally {
      this.active--;
    }
  }

  /** Verifies the signature, then routes the S3 operation. */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    const [path = "/", qs = ""] = raw.split("?", 2);
    const query = [...new URLSearchParams(qs).entries()];
    const q = new Map(query);
    if (!this.verifySignature(req, path, query)) {
      req.resume();
      return this.error(res, 403, "SignatureDoesNotMatch", "signature mismatch");
    }
    if (this.dropBefore > 0) {
      this.dropBefore--;
      req.socket.destroy();
      return;
    }
    if (this.stall > 0) {
      this.stall--;
      req.resume();
      return;
    }
    const injected = this.failQueue.shift();
    if (injected) {
      req.resume();
      return this.error(res, injected.status, injected.code, "injected failure");
    }
    const prefix = `/${this.opts.bucket}/`;
    if (!path.startsWith(prefix)) {
      req.resume();
      return this.error(res, 404, "NoSuchBucket", "unknown bucket");
    }
    const key = decodeURIComponent(path.slice(prefix.length));
    const method = req.method ?? "GET";
    const answer = await this.operate(method, key, q, req);
    const isComplete = method === "POST" && q.has("uploadId") && answer.status === 200;
    if (this.dropAfter > 0 || (isComplete && this.dropComplete > 0)) {
      if (isComplete && this.dropComplete > 0) this.dropComplete--;
      else this.dropAfter--;
      req.socket.destroy();
      return;
    }
    for (const [k, v] of Object.entries(answer.headers ?? {})) res.setHeader(k, v);
    if (answer.file !== undefined) {
      res.writeHead(answer.status);
      await pipeline(createReadStream(answer.file), res);
      return;
    }
    res.writeHead(answer.status).end(answer.body ?? "");
  }

  /** Carries out one S3 operation and returns the answer. */
  private async operate(
    method: string,
    key: string,
    q: Map<string, string>,
    req: IncomingMessage,
  ): Promise<{ status: number; headers?: Record<string, string>; body?: string; file?: string }> {
    const uploadId = q.get("uploadId");
    if (method === "POST" && q.has("uploads")) {
      req.resume();
      const id = randomBytes(12).toString("hex");
      this.uploads.set(id, { key, parts: new Map() });
      return { status: 200, body: `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>` };
    }
    if (uploadId !== undefined) {
      const up = this.uploads.get(uploadId);
      if (!up || up.key !== key) {
        req.resume();
        return errorAnswer(404, "NoSuchUpload", "no such upload");
      }
      if (method === "PUT") {
        const n = Number(q.get("partNumber"));
        if (!Number.isInteger(n) || n < 1 || n > 10_000) return errorAnswer(400, "InvalidArgument", "bad partNumber");
        const body = await this.receive(req);
        if (typeof body === "string") return errorAnswer(400, "XAmzContentSHA256Mismatch", body);
        const old = up.parts.get(n);
        if (old) await rm(old.file, { force: true });
        up.parts.set(n, { etag: `"${body.md5}"`, size: body.size, file: body.file });
        this.partSizes.push(body.size);
        return { status: 200, headers: { ETag: `"${body.md5}"` } };
      }
      if (method === "POST") return this.complete(uploadId, up, req);
      if (method === "DELETE") {
        req.resume();
        for (const p of up.parts.values()) await rm(p.file, { force: true });
        this.uploads.delete(uploadId);
        return { status: 204 };
      }
    }
    if (method === "PUT") {
      const body = await this.receive(req);
      if (typeof body === "string") return errorAnswer(400, "XAmzContentSHA256Mismatch", body);
      const ct = req.headers["content-type"];
      this.objects.set(key, { file: body.file, size: body.size, sha256: body.sha256, ...(ct ? { contentType: ct } : {}) });
      return { status: 200, headers: { ETag: `"${body.md5}"` } };
    }
    req.resume();
    const obj = this.objects.get(key);
    if (method === "DELETE") {
      if (obj) await rm(obj.file, { force: true });
      this.objects.delete(key);
      return { status: 204 };
    }
    if (method === "HEAD" || method === "GET") {
      if (!obj) return errorAnswer(404, "NoSuchKey", "no such key");
      const headers = { "Content-Length": String(obj.size) };
      return method === "HEAD" ? { status: 200, headers } : { status: 200, headers, file: obj.file };
    }
    return errorAnswer(405, "MethodNotAllowed", "unsupported");
  }

  /** CompleteMultipartUpload: checks the part list against S3's rules and joins the parts. */
  private async complete(uploadId: string, up: Upload, req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    const xml = Buffer.concat(chunks).toString("utf8");
    const listed = [...xml.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g)].map((m) => ({
      n: Number(m[1]),
      etag: (m[2] ?? "").replace(/&quot;/g, '"'),
    }));
    if (listed.length === 0) return errorAnswer(400, "MalformedXML", "no parts");
    const min = this.opts.minPartSize ?? 5 * 1024 * 1024;
    for (let i = 1; i < listed.length; i++) {
      if ((listed[i]?.n ?? 0) <= (listed[i - 1]?.n ?? 0)) return errorAnswer(400, "InvalidPartOrder", "parts not ascending");
    }
    for (const [i, p] of listed.entries()) {
      const stored = up.parts.get(p.n);
      if (!stored || stored.etag !== p.etag) return errorAnswer(400, "InvalidPart", `part ${p.n}`);
      if (i < listed.length - 1 && stored.size < min) return errorAnswer(400, "EntityTooSmall", `part ${p.n}`);
    }
    const file = join(this.opts.dir, `obj-${randomBytes(8).toString("hex")}`);
    const out = createWriteStream(file);
    const hash = createHash("sha256");
    let size = 0;
    for (const p of listed) {
      const part = up.parts.get(p.n) as Part;
      for await (const c of createReadStream(part.file) as AsyncIterable<Buffer>) {
        hash.update(c);
        size += c.length;
        if (!out.write(c)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    for (const p of up.parts.values()) await rm(p.file, { force: true });
    const old = this.objects.get(up.key);
    if (old) await rm(old.file, { force: true });
    this.objects.set(up.key, { file, size, sha256: hash.digest("hex") });
    this.uploads.delete(uploadId);
    return { status: 200, body: `<CompleteMultipartUploadResult><Key>${up.key}</Key></CompleteMultipartUploadResult>` };
  }

  /** Streams a request body to a file, checking it against x-amz-content-sha256. */
  private async receive(req: IncomingMessage): Promise<{ file: string; size: number; md5: string; sha256: string } | string> {
    const file = join(this.opts.dir, `body-${randomBytes(8).toString("hex")}`);
    const sha = createHash("sha256");
    const md5 = createHash("md5");
    let size = 0;
    await pipeline(
      req,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const c of src) {
          sha.update(c);
          md5.update(c);
          size += c.length;
          yield c;
        }
      },
      createWriteStream(file),
    );
    const sha256 = sha.digest("hex");
    if (sha256 !== req.headers["x-amz-content-sha256"]) {
      await rm(file, { force: true });
      return "body does not match x-amz-content-sha256";
    }
    return { file, size, md5: md5.digest("hex"), sha256 };
  }

  /** Recomputes the SigV4 signature from the request as received. */
  private verifySignature(req: IncomingMessage, path: string, query: [string, string][]): boolean {
    const auth = req.headers.authorization ?? "";
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
    if (!m || m[1] !== this.opts.credentials.accessKeyId || m[3] !== (this.opts.region ?? "us-east-1")) return false;
    const signedNames = (m[4] ?? "").split(";");
    for (const required of ["host", "x-amz-date", "x-amz-content-sha256"]) if (!signedNames.includes(required)) return false;
    const headers: Record<string, string> = {};
    for (const name of signedNames) {
      const v = req.headers[name];
      if (v === undefined) return false;
      headers[name] = Array.isArray(v) ? v.join(",") : v;
    }
    const expected = sign({
      method: req.method ?? "GET",
      path,
      query,
      headers,
      payloadHash: headers["x-amz-content-sha256"] ?? "",
      region: this.opts.region ?? "us-east-1",
      service: "s3",
      credentials: this.opts.credentials,
    });
    return expected.signature === m[5];
  }

  /** Writes an S3-style XML error. */
  private error(res: ServerResponse, status: number, code: string, message: string): void {
    const a = errorAnswer(status, code, message);
    res.writeHead(a.status, { "Content-Type": "application/xml" }).end(a.body);
  }
}

/** S3-style XML error answer. */
function errorAnswer(status: number, code: string, message: string): { status: number; body: string } {
  return { status, body: `<Error><Code>${code}</Code><Message>${message}</Message></Error>` };
}
