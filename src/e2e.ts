// End-to-end check against a real S3-compatible server (moto in CI and locally): a resumed upload with
// 5 MiB parts must read back byte for byte, and a terminated upload must leave nothing behind.
// Needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (see README). Exit 1 on failure.
import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { bufferSource, currentOffset, upload } from "./client.js";
import { loadConfig } from "./config.js";
import { S3Client } from "./s3.js";
import { startServer } from "./server.js";
import { UploadStore } from "./store.js";

const MIB = 1024 * 1024;

/** Sends part of a PATCH body, then cuts the connection (a dropped upload). */
async function interruptedPatch(url: string, total: number, part: Buffer): Promise<void> {
  const u = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(
        `PATCH ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nTus-Resumable: 1.0.0\r\n` +
          `Content-Type: application/offset+octet-stream\r\nUpload-Offset: 0\r\nContent-Length: ${total}\r\n\r\n`,
      );
      sock.write(part, () => setTimeout(() => (sock.destroy(), resolve()), 1500));
    });
    sock.on("error", reject);
  });
}

/** Runs the checks and prints one result line. */
async function main(): Promise<void> {
  const cfg = loadConfig({ PART_SIZE: String(5 * MIB), ...process.env });
  const s3 = new S3Client({
    endpoint: cfg.s3Endpoint,
    region: cfg.s3Region,
    bucket: cfg.s3Bucket,
    credentials: { accessKeyId: cfg.s3AccessKeyId, secretAccessKey: cfg.s3SecretAccessKey },
    forcePathStyle: cfg.s3ForcePathStyle,
    timeoutMs: cfg.s3TimeoutMs,
  });
  await s3.createBucket();
  const dir = join(process.cwd(), ".tmp", `e2e-${randomBytes(4).toString("hex")}`);
  const server = await startServer({ s3, store: new UploadStore(dir), partSize: cfg.partSize, maxSize: 64 * MIB });
  try {
    const data = randomBytes(11 * MIB + 3);
    const created = await fetch(`${server.url}/files`, {
      method: "POST",
      headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(data.length) },
      signal: AbortSignal.timeout(30_000),
    });
    const location = created.headers.get("location");
    if (created.status !== 201 || location === null) throw new Error(`create failed: ${created.status}`);
    const url = new URL(location, server.url).toString();
    await interruptedPatch(url, data.length, data.subarray(0, 7 * MIB));
    const kept = await currentOffset(new URL(url));
    const result = await upload({ endpoint: `${server.url}/files`, uploadUrl: url, source: bufferSource(data), chunkSize: 3 * MIB });
    const key = `uploads/${location.split("/").pop() ?? ""}`;
    const got = await s3.objectDigest(key);
    const want = createHash("sha256").update(data).digest("hex");
    if (got.sha256 !== want || got.size !== data.length) throw new Error("object does not match the uploaded bytes");

    // Termination: an unfinished upload is aborted on S3.
    const t = await fetch(`${server.url}/files`, {
      method: "POST",
      headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(6 * MIB) },
      signal: AbortSignal.timeout(30_000),
    });
    const tUrl = new URL(t.headers.get("location") ?? "", server.url).toString();
    // Only the first 5 MiB of 6 are sent, so one part is stored and the upload stays unfinished.
    await upload({ endpoint: `${server.url}/files`, uploadUrl: tUrl, source: bufferSource(randomBytes(5 * MIB)), chunkSize: 5 * MIB });
    const del = await fetch(tUrl, { method: "DELETE", headers: { "Tus-Resumable": "1.0.0" }, signal: AbortSignal.timeout(30_000) });
    if (del.status !== 204) throw new Error(`DELETE answered ${del.status}`);
    if ((await s3.headObject(`uploads/${tUrl.split("/").pop() ?? ""}`)) !== undefined) throw new Error("terminated upload left an object");

    console.log(
      `E2E PASS: ${data.length} bytes in ${Math.ceil(data.length / cfg.partSize)} parts, kept ${kept} bytes after the cut, ` +
        `${result.resumes} client resumes, sha256 ${want.slice(0, 16)}; termination aborted the multipart upload`,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`E2E FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
