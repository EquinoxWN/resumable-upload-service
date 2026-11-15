import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { offsetOf, UploadStore, type UploadInfo } from "../src/store.js";
import { scratch } from "./helpers.js";

/** A sample upload info. */
function sample(id: string = randomUUID()): UploadInfo {
  return {
    id,
    length: 100,
    metadata: { filename: "a.txt" },
    key: `uploads/${id}`,
    s3UploadId: "abc",
    parts: [{ partNumber: 1, etag: '"e1"', size: 40 }],
    spoolSize: 7,
    completed: false,
    createdAt: new Date().toISOString(),
  };
}

test("save and load round trip; saving twice leaves one file and no temporary files", async () => {
  const dir = scratch();
  try {
    const store = new UploadStore(dir);
    await store.init();
    const info = sample();
    await store.save(info);
    await store.save({ ...info, spoolSize: 9 });
    assert.deepEqual(await store.load(info.id), { ...info, spoolSize: 9 });
    assert.deepEqual(await readdir(dir), [`${info.id}.json`]);
    assert.equal(offsetOf(info), 47);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown and malformed ids load as undefined; writing with a malformed id throws", async () => {
  const dir = scratch();
  try {
    const store = new UploadStore(dir);
    await store.init();
    assert.equal(await store.load(randomUUID()), undefined);
    assert.equal(await store.load("../../package"), undefined);
    await assert.rejects(store.save(sample("../escape")), /invalid upload id/);
    await assert.rejects(store.writeSpool("..\\x", Buffer.from("a")), /invalid upload id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt or mismatched info file is an error, not a silent reset", async () => {
  const dir = scratch();
  try {
    const store = new UploadStore(dir);
    await store.init();
    const id = randomUUID();
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...sample(id), parts: "nope" }));
    await assert.rejects(store.load(id), /corrupt/);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(sample(randomUUID())));
    await assert.rejects(store.load(id), /corrupt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spool: only the recorded prefix is read; a short spool file is an error; remove deletes all", async () => {
  const dir = scratch();
  try {
    const store = new UploadStore(dir);
    await store.init();
    const info = sample();
    await store.save(info);
    await store.writeSpool(info.id, Buffer.from("abcdefghij"));
    assert.equal((await store.readSpool(info.id, 4)).toString(), "abcd");
    assert.equal((await store.readSpool(info.id, 0)).length, 0);
    await assert.rejects(store.readSpool(info.id, 11), /shorter/);
    await store.remove(info.id);
    assert.deepEqual(await readdir(dir), []);
    await store.remove(info.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
