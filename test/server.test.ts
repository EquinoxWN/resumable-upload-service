import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { create, KIB, offset, patch, rig, sha, tus, until } from "./helpers.js";

/** Opens a raw PATCH, writes `send` of the `total` declared bytes and returns the socket. */
function rawPatch(url: string, at: number, total: number, send: Buffer, extraHeaders = "") {
  const u = new URL(url);
  const sock = connect(Number(u.port), u.hostname);
  sock.on("error", () => undefined);
  sock.write(
    `PATCH ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nTus-Resumable: 1.0.0\r\n` +
      `Content-Type: application/offset+octet-stream\r\nUpload-Offset: ${at}\r\n` +
      `Content-Length: ${total}\r\n${extraHeaders}\r\n`,
  );
  sock.write(send);
  return sock;
}

describe("protocol basics", () => {
  test("OPTIONS advertises version, extensions and max size without Tus-Resumable", async () => {
    const r = await rig();
    try {
      const res = await tus("OPTIONS", r.files, { "Tus-Resumable": "" });
      assert.equal(res.status, 204);
      assert.equal(res.headers["tus-version"], "1.0.0");
      assert.equal(res.headers["tus-extension"], "creation,termination");
      assert.equal(res.headers["tus-max-size"], String(4 * 1024 * KIB));
      assert.equal(res.headers["tus-resumable"], "1.0.0");
    } finally {
      await r.close();
    }
  });

  test("requests without Tus-Resumable 1.0.0 get 412 and Tus-Version", async () => {
    const r = await rig();
    try {
      for (const v of ["", "0.2.2"]) {
        const res = await tus("POST", r.files, { "Tus-Resumable": v, "Upload-Length": "10" });
        assert.equal(res.status, 412);
        assert.equal(res.headers["tus-version"], "1.0.0");
      }
      assert.equal(r.fake.uploads.size, 0);
    } finally {
      await r.close();
    }
  });

  test("POST creates an upload: 201 Location, HEAD offset 0, metadata echoed, S3 multipart started", async () => {
    const r = await rig();
    try {
      const meta = `filename ${Buffer.from("report.pdf").toString("base64")},filetype ${Buffer.from("application/pdf").toString("base64")}`;
      const res = await tus("POST", r.files, { "Upload-Length": "1000", "Upload-Metadata": meta });
      assert.equal(res.status, 201);
      assert.match(String(res.headers["location"]), /^\/files\/[0-9a-f-]{36}$/);
      const url = new URL(String(res.headers["location"]), r.server.url).toString();
      const head = await tus("HEAD", url);
      assert.equal(head.status, 200);
      assert.equal(head.headers["upload-offset"], "0");
      assert.equal(head.headers["upload-length"], "1000");
      assert.equal(head.headers["cache-control"], "no-store");
      assert.equal(head.headers["upload-metadata"], meta);
      assert.equal(r.fake.uploads.size, 1);
    } finally {
      await r.close();
    }
  });

  test("POST validation: bad or missing lengths, too large, deferred length, bad metadata, a body", async () => {
    const r = await rig();
    try {
      const cases: [Record<string, string>, number][] = [
        [{}, 400],
        [{ "Upload-Length": "-1" }, 400],
        [{ "Upload-Length": "abc" }, 400],
        [{ "Upload-Length": "1e3" }, 400],
        [{ "Upload-Length": "99999999999999999" }, 400],
        [{ "Upload-Length": String(4 * 1024 * KIB + 1) }, 413],
        [{ "Upload-Defer-Length": "1" }, 400],
        [{ "Upload-Length": "10", "Upload-Metadata": "name not-base64!" }, 400],
        [{ "Upload-Length": "10", "Upload-Metadata": "a YQ==,a Yg==" }, 400],
      ];
      for (const [headers, status] of cases) {
        const res = await tus("POST", r.files, headers);
        assert.equal(res.status, status, JSON.stringify(headers));
      }
      const withBody = await tus("POST", r.files, { "Upload-Length": "3" }, Buffer.from("abc"));
      assert.equal(withBody.status, 400);
      assert.equal(r.fake.uploads.size, 0, "no S3 upload is started for a refused request");
    } finally {
      await r.close();
    }
  });

  test("an upload that would need more than 10,000 parts is refused", async () => {
    const r = await rig({ partSize: 1, maxSize: 20_000 });
    try {
      assert.equal((await tus("POST", r.files, { "Upload-Length": "10000" })).status, 201);
      assert.equal((await tus("POST", r.files, { "Upload-Length": "10001" })).status, 413);
    } finally {
      await r.close();
    }
  });

  test("unknown ids, path tricks, other paths and methods", async () => {
    const r = await rig();
    try {
      const { url } = await create(r, 10);
      assert.equal((await tus("HEAD", `${r.files}/00000000-0000-4000-8000-000000000000`)).status, 404);
      assert.equal((await tus("HEAD", `${r.files}/..%2F..%2Fpackage.json`)).status, 404);
      assert.equal((await tus("HEAD", `${r.server.url}/other`)).status, 404);
      const get = await tus("GET", url);
      assert.equal(get.status, 405);
      assert.match(String(get.headers["allow"]), /PATCH/);
      assert.equal((await tus("GET", r.files)).status, 405);
    } finally {
      await r.close();
    }
  });

  test("CORS headers only for allowed origins", async () => {
    const r = await rig({ allowedOrigins: ["https://app.example"] });
    try {
      const ok = await tus("OPTIONS", r.files, { Origin: "https://app.example" });
      assert.equal(ok.headers["access-control-allow-origin"], "https://app.example");
      assert.match(String(ok.headers["access-control-expose-headers"]), /Upload-Offset/);
      assert.match(String(ok.headers["access-control-allow-methods"]), /PATCH/);
      const other = await tus("OPTIONS", r.files, { Origin: "https://evil.example" });
      assert.equal(other.headers["access-control-allow-origin"], undefined);
    } finally {
      await r.close();
    }
  });
});

describe("uploading into S3 multipart parts", () => {
  test("uneven chunks become full-size parts plus a short last part; the object matches byte for byte", async () => {
    const r = await rig();
    try {
      const data = randomBytes(300 * KIB + 7);
      const meta = `filetype ${Buffer.from("image/png").toString("base64")}`;
      const { url } = await create(r, data.length, { "Upload-Metadata": meta });
      let at = 0;
      for (const size of [100 * KIB, 1, 50 * KIB, 99 * KIB, 51 * KIB + 6]) {
        const res = await patch(url, at, data.subarray(at, at + size));
        assert.equal(res.status, 204, res.text);
        at += size;
        assert.equal(res.headers["upload-offset"], String(at));
      }
      assert.equal(at, data.length);
      assert.deepEqual(r.fake.partSizes, [64 * KIB, 64 * KIB, 64 * KIB, 64 * KIB, 44 * KIB + 7]);
      const objects = [...r.fake.objects.values()];
      assert.equal(objects.length, 1);
      assert.equal(objects[0]?.sha256, sha(data));
      assert.equal(r.fake.uploads.size, 0, "the multipart upload was completed");
      assert.equal((await r.s3.objectDigest([...r.fake.objects.keys()][0] ?? "")).sha256, sha(data));
      assert.equal(await offset(url), data.length);
    } finally {
      await r.close();
    }
  });

  test("a file smaller than one part is a single-part upload", async () => {
    const r = await rig();
    try {
      const data = randomBytes(1000);
      const { url } = await create(r, data.length);
      assert.equal((await patch(url, 0, data)).status, 204);
      assert.deepEqual(r.fake.partSizes, [1000]);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("a zero-length upload is complete at creation (one empty PutObject)", async () => {
    const r = await rig();
    try {
      const { url } = await create(r, 0);
      assert.equal(await offset(url), 0);
      assert.equal(r.fake.uploads.size, 0);
      assert.equal([...r.fake.objects.values()][0]?.size, 0);
      assert.equal((await patch(url, 0, Buffer.alloc(0))).status, 204);
    } finally {
      await r.close();
    }
  });

  test("wrong Upload-Offset gets 409 with the real offset and changes nothing", async () => {
    const r = await rig();
    try {
      const data = randomBytes(10 * KIB);
      const { url } = await create(r, data.length);
      assert.equal((await patch(url, 0, data.subarray(0, 4 * KIB))).status, 204);
      const res = await patch(url, 0, data.subarray(0, 4 * KIB));
      assert.equal(res.status, 409);
      assert.equal(res.headers["upload-offset"], String(4 * KIB));
      assert.equal((await patch(url, 5 * KIB, data.subarray(5 * KIB))).status, 409);
      assert.equal((await patch(url, 4 * KIB, data.subarray(4 * KIB))).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("PATCH needs the offset content type and a numeric Upload-Offset", async () => {
    const r = await rig();
    try {
      const { url } = await create(r, 10);
      assert.equal((await patch(url, 0, Buffer.from("a"), { "Content-Type": "application/json" })).status, 415);
      assert.equal((await patch(url, 0, Buffer.from("a"), { "Upload-Offset": "x" })).status, 400);
      assert.equal(await offset(url), 0);
    } finally {
      await r.close();
    }
  });

  test("a body that goes past Upload-Length is refused before anything is stored", async () => {
    const r = await rig();
    try {
      const { url } = await create(r, 10);
      const res = await patch(url, 0, randomBytes(11));
      assert.equal(res.status, 413);
      assert.equal(await offset(url), 0);
      assert.equal(r.fake.partSizes.length, 0);
    } finally {
      await r.close();
    }
  });

  for (const extra of [1, 40]) {
  test(`a chunked body ${extra} byte(s) past Upload-Length: bytes up to the length are kept and the upload completes`, { timeout: 10_000 }, async () => {
    const r = await rig();
    try {
      const data = randomBytes(60 + extra);
      const { url, id } = await create(r, 60);
      const ended = r.patchEnd(id);
      const u = new URL(url);
      const sock = connect(Number(u.port), u.hostname);
      sock.on("error", () => undefined);
      sock.write(
        `PATCH ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nTus-Resumable: 1.0.0\r\n` +
          `Content-Type: application/offset+octet-stream\r\nUpload-Offset: 0\r\nTransfer-Encoding: chunked\r\n\r\n` +
          `${data.length.toString(16)}\r\n`,
      );
      sock.write(data);
      sock.write("\r\n0\r\n\r\n");
      let answer = "";
      sock.on("data", (c: Buffer) => (answer += c.toString()));
      assert.equal(await ended, 60);
      await until(() => answer.includes("\r\n\r\n"));
      assert.match(answer, /^HTTP\/1\.1 413/);
      sock.destroy();
      assert.equal(await offset(url), 60);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data.subarray(0, 60)));
    } finally {
      await r.close();
    }
  });
  }

  test("a PATCH ending one byte before a part boundary does not produce a short part", async () => {
    const r = await rig();
    try {
      const data = randomBytes(130 * KIB);
      const { url } = await create(r, data.length);
      const cut = 64 * KIB - 1;
      assert.equal((await patch(url, 0, data.subarray(0, cut))).status, 204);
      assert.equal(r.fake.partSizes.length, 0, "the 64 KiB - 1 bytes wait in the spool");
      assert.equal((await patch(url, cut, data.subarray(cut))).status, 204);
      assert.deepEqual(r.fake.partSizes, [64 * KIB, 64 * KIB, 2 * KIB]);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });
});

describe("resuming after failures", () => {
  test("a connection dropped mid-PATCH keeps every byte received; the client resumes from HEAD", async () => {
    const r = await rig();
    try {
      const data = randomBytes(300 * KIB);
      const { url, id } = await create(r, data.length);
      const ended = r.patchEnd(id);
      const sock = rawPatch(url, 0, data.length, data.subarray(0, 150 * KIB));
      await until(() => r.fake.partSizes.length >= 2);
      sock.destroy();
      const kept = await ended;
      assert.ok(kept >= 128 * KIB && kept <= 150 * KIB, `kept ${kept}`);
      assert.equal(await offset(url), kept);
      const spools = (await readdir(join(r.dir, "state"))).filter((f) => f.endsWith(".spool"));
      assert.equal(spools.length, kept > 128 * KIB ? 1 : 0, "the unfinished part is spooled to disk");
      const res = await patch(url, kept, data.subarray(kept));
      assert.equal(res.status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
      assert.ok(r.fake.partSizes.slice(0, -1).every((s) => s === 64 * KIB), "every part but the last is full size");
    } finally {
      await r.close();
    }
  });

  test("a HEAD sent while a PATCH is still running waits for it and reports the saved bytes", async () => {
    const r = await rig({ lockWaitMs: 2_000 });
    try {
      const data = randomBytes(20 * KIB);
      const { url } = await create(r, data.length);
      const sock = rawPatch(url, 0, data.length, data.subarray(0, 10 * KIB));
      await new Promise((res) => setTimeout(res, 200));
      const head = offset(url);
      await new Promise((res) => setTimeout(res, 100));
      sock.destroy();
      assert.equal(await head, 10 * KIB);
    } finally {
      await r.close();
    }
  });

  test("a stalled PATCH is cut after the idle timeout and its bytes are kept", async () => {
    const r = await rig({ idleTimeoutMs: 300 });
    try {
      const data = randomBytes(20 * KIB);
      const { url, id } = await create(r, data.length);
      const ended = r.patchEnd(id);
      const sock = rawPatch(url, 0, data.length, data.subarray(0, 5 * KIB));
      const kept = await ended;
      sock.destroy();
      assert.equal(kept, 5 * KIB);
      assert.equal((await patch(url, kept, data.subarray(kept))).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("a second PATCH on a busy upload gets 423 and does not corrupt it", async () => {
    const r = await rig();
    try {
      const data = randomBytes(10 * KIB);
      const { url, id } = await create(r, data.length);
      const ended = r.patchEnd(id);
      const sock = rawPatch(url, 0, data.length, data.subarray(0, KIB));
      await until(() => r.fake.requests >= 1);
      await new Promise((res) => setTimeout(res, 200));
      const second = await patch(url, 0, data);
      assert.equal(second.status, 423);
      sock.write(data.subarray(KIB));
      assert.equal(await ended, data.length);
      sock.destroy();
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("PATCH requests beyond the concurrency limit get 503", async () => {
    const r = await rig({ maxConcurrentPatches: 1 });
    try {
      const a = await create(r, 2 * KIB);
      const b = await create(r, 2 * KIB);
      const ended = r.patchEnd(a.id);
      const sock = rawPatch(a.url, 0, 2 * KIB, randomBytes(KIB));
      await new Promise((res) => setTimeout(res, 100));
      const res = await patch(b.url, 0, randomBytes(2 * KIB));
      assert.equal(res.status, 503);
      assert.equal(res.headers["retry-after"], "1");
      sock.destroy();
      await ended;
      assert.equal((await patch(b.url, 0, randomBytes(2 * KIB))).status, 204);
    } finally {
      await r.close();
    }
  });

  test("a short S3 outage is retried inside the request", async () => {
    const r = await rig();
    try {
      const data = randomBytes(70 * KIB);
      const { url } = await create(r, data.length);
      r.fake.failNext(2);
      assert.equal((await patch(url, 0, data)).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("a longer S3 outage answers 503 and keeps the bytes; a later retry finishes the upload", async () => {
    const r = await rig();
    try {
      const data = randomBytes(100 * KIB);
      const { url, id } = await create(r, data.length);
      r.fake.failNext(3);
      const ended = r.patchEnd(id);
      const res = await patch(url, 0, data.subarray(0, 64 * KIB));
      await ended;
      assert.equal(res.status, 503);
      assert.equal(await offset(url), 64 * KIB, "the refused part is spooled, not lost");
      assert.equal(r.errors.length, 1, "the storage error is logged");
      assert.equal((await patch(url, 64 * KIB, data.subarray(64 * KIB))).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("an S3 failure on the last part is finished later by an empty PATCH at the final offset", async () => {
    const r = await rig({}, { maxAttempts: 1 });
    try {
      const data = randomBytes(10 * KIB);
      const { url } = await create(r, data.length);
      r.fake.failNext(1);
      assert.equal((await patch(url, 0, data)).status, 503);
      assert.equal(await offset(url), data.length);
      assert.equal(r.fake.objects.size, 0);
      assert.equal((await patch(url, data.length, Buffer.alloc(0))).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("a lost CompleteMultipartUpload answer is detected on retry and not reported as a failure", async () => {
    const r = await rig();
    try {
      const data = randomBytes(10 * KIB);
      const { url } = await create(r, data.length);
      r.fake.dropCompleteResponseNext(1);
      assert.equal((await patch(url, 0, data)).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });

  test("a restarted server resumes an upload begun before the restart", async () => {
    const r = await rig();
    try {
      const data = randomBytes(150 * KIB);
      const { url } = await create(r, data.length);
      assert.equal((await patch(url, 0, data.subarray(0, 100 * KIB))).status, 204);
      await r.server.close();
      const again = await r.restart();
      const url2 = url.replace(r.server.url, again.url);
      assert.equal(await offset(url2), 100 * KIB);
      assert.equal((await patch(url2, 100 * KIB, data.subarray(100 * KIB))).status, 204);
      assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
    } finally {
      await r.close();
    }
  });
});

describe("termination", () => {
  test("DELETE of an unfinished upload aborts the S3 multipart upload and forgets the upload", async () => {
    const r = await rig();
    try {
      const { url } = await create(r, 100 * KIB);
      assert.equal((await patch(url, 0, randomBytes(70 * KIB))).status, 204);
      assert.equal(r.fake.uploads.size, 1);
      assert.equal((await tus("DELETE", url)).status, 204);
      assert.equal(r.fake.uploads.size, 0);
      assert.equal((await tus("HEAD", url)).status, 404);
      assert.deepEqual(await readdir(join(r.dir, "state")), []);
      assert.equal((await tus("DELETE", url)).status, 404);
    } finally {
      await r.close();
    }
  });

  test("DELETE of a finished upload deletes the object", async () => {
    const r = await rig();
    try {
      const { url, id } = await create(r, 5);
      assert.equal((await patch(url, 0, Buffer.from("hello"))).status, 204);
      assert.ok(r.fake.objects.has(`uploads/${id}`));
      assert.equal((await tus("DELETE", url)).status, 204);
      assert.equal(r.fake.objects.size, 0);
    } finally {
      await r.close();
    }
  });
});
