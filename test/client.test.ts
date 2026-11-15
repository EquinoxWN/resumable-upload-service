import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { bufferSource, currentOffset, upload } from "../src/client.js";
import { create, KIB, rig, sha } from "./helpers.js";

/** TCP proxy that cuts each of the first `cuts` connections after `afterBytes` bytes from the client. */
async function cuttingProxy(target: string, afterBytes: number, cuts: number) {
  const t = new URL(target);
  let remaining = cuts;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = connect(Number(t.port), t.hostname);
    sockets.add(upstream);
    const cut = remaining > 0;
    if (cut) remaining--;
    let seen = 0;
    client.on("data", (c: Buffer) => {
      seen += c.length;
      if (cut && seen > afterBytes) {
        upstream.write(c.subarray(0, c.length - (seen - afterBytes)));
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(c);
    });
    upstream.on("data", (c: Buffer) => client.write(c));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.end());
    upstream.on("close", () => client.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

test("the client resumes from HEAD after connections are cut mid-chunk; the object is intact", async () => {
  const r = await rig();
  const proxy = await cuttingProxy(r.server.url, 90 * KIB, 2);
  try {
    const data = randomBytes(400 * KIB);
    const seen: number[] = [];
    const result = await upload({
      endpoint: `${proxy.url}/files`,
      source: bufferSource(data),
      metadata: { filename: "photo.jpg" },
      chunkSize: 128 * KIB,
      backoffMs: 20,
      onProgress: (o) => seen.push(o),
    });
    assert.ok(result.resumes >= 1, `resumes ${result.resumes}`);
    assert.equal(seen.at(-1), data.length);
    assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
  } finally {
    await proxy.close();
    await r.close();
  }
});

test("the client continues an existing upload from its URL", async () => {
  const r = await rig();
  try {
    const data = randomBytes(100 * KIB);
    const { url } = await create(r, data.length);
    const first = await upload({ endpoint: r.files, uploadUrl: url, source: { size: data.length, read: (s, e) => Promise.resolve(data.subarray(s, Math.min(e, 30 * KIB))) }, chunkSize: 30 * KIB, maxRetries: 0 }).catch((e: unknown) => e);
    assert.ok(first instanceof Error, "stops when the source ends early");
    assert.equal(await currentOffset(new URL(url)), 30 * KIB);
    const done = await upload({ endpoint: r.files, uploadUrl: url, source: bufferSource(data), chunkSize: 30 * KIB });
    assert.equal(done.url, url);
    assert.equal([...r.fake.objects.values()][0]?.sha256, sha(data));
  } finally {
    await r.close();
  }
});

test("the client gives up after maxRetries when the server is unreachable", async () => {
  const r = await rig();
  const { url } = await create(r, 10);
  await r.close();
  const started = performance.now();
  await assert.rejects(
    upload({ endpoint: "http://127.0.0.1:9/files", uploadUrl: url, source: bufferSource(Buffer.alloc(10)), maxRetries: 2, backoffMs: 5, timeoutMs: 1000 }),
  );
  assert.ok(performance.now() - started < 10_000);
});
