import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { FakeS3 } from "../src/testing/fakes3.js";
import { S3Client, S3Error, xmlTag } from "../src/s3.js";
import { BUCKET, CREDS, KIB, scratch, sha } from "./helpers.js";

/** A fake S3 and a client for it; `fn` runs with both, then everything is removed. */
async function withS3(fn: (fake: FakeS3, s3: S3Client) => Promise<void>, client: { secret?: string; timeoutMs?: number } = {}) {
  const fake = new FakeS3({ dir: scratch(), bucket: BUCKET, credentials: CREDS, minPartSize: 64 * KIB });
  const endpoint = await fake.start();
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    credentials: { accessKeyId: CREDS.accessKeyId, secretAccessKey: client.secret ?? CREDS.secretAccessKey },
    backoffMs: 5,
    timeoutMs: client.timeoutMs ?? 5_000,
  });
  try {
    await fn(fake, s3);
  } finally {
    await fake.stop();
  }
}

test("multipart round trip with a key that needs encoding; the object reads back identical", async () => {
  await withS3(async (fake, s3) => {
    const key = "uploads/a file+name é.bin";
    const a = randomBytes(64 * KIB);
    const b = randomBytes(10);
    const id = await s3.createMultipartUpload(key, "application/octet-stream");
    const e1 = await s3.uploadPart(key, id, 1, a);
    const e2 = await s3.uploadPart(key, id, 2, b);
    await s3.completeMultipartUpload(key, id, [
      { partNumber: 1, etag: e1 },
      { partNumber: 2, etag: e2 },
    ]);
    assert.deepEqual(await s3.objectDigest(key), { size: a.length + b.length, sha256: sha(Buffer.concat([a, b])) });
    assert.equal(await s3.headObject(key), a.length + b.length);
    assert.equal(await s3.headObject("missing"), undefined);
    assert.equal(fake.uploads.size, 0);
  });
});

test("a re-sent part with the same number replaces the old one (idempotent part upload)", async () => {
  await withS3(async (_fake, s3) => {
    const id = await s3.createMultipartUpload("k");
    await s3.uploadPart("k", id, 1, Buffer.from("first"));
    const etag = await s3.uploadPart("k", id, 1, Buffer.from("second"));
    await s3.completeMultipartUpload("k", id, [{ partNumber: 1, etag }]);
    assert.equal((await s3.objectDigest("k")).sha256, sha(Buffer.from("second")));
  });
});

test("throttling and 5xx are retried with backoff up to maxAttempts, then surfaced", async () => {
  await withS3(async (fake, s3) => {
    fake.failNext(2, 503, "SlowDown");
    const id = await s3.createMultipartUpload("k");
    assert.ok(id.length > 0);
    const before = fake.requests;
    fake.failNext(3, 500, "InternalError");
    await assert.rejects(s3.uploadPart("k", id, 1, Buffer.from("x")), (e: unknown) => e instanceof S3Error && e.code === "InternalError" && e.retryable);
    assert.equal(fake.requests - before, 3);
  });
});

test("4xx answers are not retried", async () => {
  await withS3(async (fake, s3) => {
    fake.failNext(1, 403, "AccessDenied");
    const before = fake.requests;
    await assert.rejects(s3.createMultipartUpload("k"), (e: unknown) => e instanceof S3Error && e.status === 403 && !e.retryable);
    assert.equal(fake.requests - before, 1);
  });
});

test("a wrong secret fails the signature check", async () => {
  await withS3(
    async (_fake, s3) => {
      await assert.rejects(s3.createMultipartUpload("k"), (e: unknown) => e instanceof S3Error && e.code === "SignatureDoesNotMatch");
    },
    { secret: "wrong-secret" },
  );
});

test("a request that never gets an answer times out and is retried", async () => {
  await withS3(
    async (fake, s3) => {
      fake.stallNext(1);
      const started = performance.now();
      const id = await s3.createMultipartUpload("k");
      assert.ok(id.length > 0);
      assert.ok(performance.now() - started >= 250, "waited for the deadline");
    },
    { timeoutMs: 300 },
  );
});

test("a cut connection is a retryable transport error", async () => {
  await withS3(async (fake, s3) => {
    fake.dropRequestNext(1);
    const id = await s3.createMultipartUpload("k");
    assert.ok(id.length > 0);
  });
});

test("a Complete whose answer was lost is recognised on retry; a really missing upload still fails", async () => {
  await withS3(async (fake, s3) => {
    const id = await s3.createMultipartUpload("k");
    const etag = await s3.uploadPart("k", id, 1, Buffer.from("data"));
    fake.dropCompleteResponseNext(1);
    await s3.completeMultipartUpload("k", id, [{ partNumber: 1, etag }]);
    assert.equal(await s3.headObject("k"), 4);
    await assert.rejects(s3.completeMultipartUpload("other", "nope", [{ partNumber: 1, etag }]), (e: unknown) => e instanceof S3Error && e.code === "NoSuchUpload");
  });
});

test("the fake enforces S3's rules: minimum part size, part order and ETags", async () => {
  await withS3(async (_fake, s3) => {
    const id = await s3.createMultipartUpload("k");
    const e1 = await s3.uploadPart("k", id, 1, Buffer.from("small"));
    const e2 = await s3.uploadPart("k", id, 2, Buffer.from("last"));
    const code = async (parts: { partNumber: number; etag: string }[]) =>
      s3.completeMultipartUpload("k", id, parts).then(
        () => "ok",
        (e: unknown) => (e as S3Error).code,
      );
    assert.equal(await code([{ partNumber: 1, etag: e1 }, { partNumber: 2, etag: e2 }]), "EntityTooSmall");
    assert.equal(await code([{ partNumber: 2, etag: e2 }, { partNumber: 1, etag: e1 }]), "InvalidPartOrder");
    assert.equal(await code([{ partNumber: 1, etag: '"bogus"' }]), "InvalidPart");
  });
});

test("abort removes the upload; aborting again is not an error; delete removes an object", async () => {
  await withS3(async (fake, s3) => {
    const id = await s3.createMultipartUpload("k");
    await s3.uploadPart("k", id, 1, Buffer.from("x"));
    await s3.abortMultipartUpload("k", id);
    await s3.abortMultipartUpload("k", id);
    assert.equal(fake.uploads.size, 0);
    await s3.putObject("o", Buffer.from("abc"));
    await s3.deleteObject("o");
    assert.equal(await s3.headObject("o"), undefined);
  });
});

test("argument and option validation", async () => {
  const creds = CREDS;
  assert.throws(() => new S3Client({ endpoint: "ftp://x", region: "r", bucket: "abc", credentials: creds }), /http/);
  assert.throws(() => new S3Client({ endpoint: "http://x", region: "r", bucket: "A_B", credentials: creds }), /bucket/);
  assert.throws(() => new S3Client({ endpoint: "http://x", region: "r", bucket: "abc", credentials: creds, maxAttempts: 0 }), /maxAttempts/);
  const s3 = new S3Client({ endpoint: "http://127.0.0.1:9", region: "r", bucket: "abc", credentials: creds });
  await assert.rejects(s3.uploadPart("k", "u", 0, Buffer.alloc(1)), RangeError);
  await assert.rejects(s3.uploadPart("k", "u", 10_001, Buffer.alloc(1)), RangeError);
  assert.equal(xmlTag("<A><B>x &amp; &quot;y&quot;</B></A>", "B"), 'x & "y"');
  assert.equal(xmlTag("<A></A>", "B"), undefined);
});
