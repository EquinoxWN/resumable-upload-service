import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";

const BASE = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_BUCKET: "uploads",
  S3_ACCESS_KEY_ID: "example-key",
  S3_SECRET_ACCESS_KEY: "example-secret",
};

test("defaults apply when only the required S3 settings are given", () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.partSize, 8 * 1024 * 1024);
  assert.equal(cfg.maxUploadSize, 5 * 1024 * 1024 * 1024);
  assert.equal(cfg.s3Region, "us-east-1");
  assert.equal(cfg.s3ForcePathStyle, true);
  assert.equal(cfg.stateDir, "data/uploads");
  assert.deepEqual(cfg.allowedOrigins, []);
});

test("every value can be set", () => {
  const cfg = loadConfig({
    ...BASE,
    PORT: "0",
    HOST: "0.0.0.0",
    S3_REGION: "eu-west-1",
    S3_FORCE_PATH_STYLE: "false",
    S3_TIMEOUT_MS: "5000",
    PART_SIZE: String(16 * 1024 * 1024),
    MAX_UPLOAD_SIZE: "1000",
    STATE_DIR: "state",
    IDLE_TIMEOUT_MS: "1000",
    MAX_CONCURRENT_PATCHES: "4",
    ALLOWED_ORIGINS: "https://a.example, http://localhost:3000",
  });
  assert.equal(cfg.port, 0);
  assert.equal(cfg.s3ForcePathStyle, false);
  assert.equal(cfg.partSize, 16 * 1024 * 1024);
  assert.deepEqual(cfg.allowedOrigins, ["https://a.example", "http://localhost:3000"]);
});

test("missing or invalid values are refused with the variable's name", () => {
  const bad: [Record<string, string>, RegExp][] = [
    [{ S3_ENDPOINT: "" }, /S3_ENDPOINT/],
    [{ S3_ENDPOINT: "not a url" }, /S3_ENDPOINT/],
    [{ S3_ENDPOINT: "ftp://x" }, /S3_ENDPOINT/],
    [{ S3_BUCKET: " " }, /S3_BUCKET/],
    [{ S3_SECRET_ACCESS_KEY: "" }, /S3_SECRET_ACCESS_KEY/],
    [{ PORT: "70000" }, /PORT/],
    [{ PORT: "abc" }, /PORT/],
    [{ PART_SIZE: String(5 * 1024 * 1024 - 1) }, /PART_SIZE/],
    [{ PART_SIZE: String(65 * 1024 * 1024) }, /PART_SIZE/],
    [{ MAX_UPLOAD_SIZE: String(8 * 1024 * 1024 * 10_000 + 1) }, /MAX_UPLOAD_SIZE/],
    [{ S3_FORCE_PATH_STYLE: "yes" }, /S3_FORCE_PATH_STYLE/],
    [{ ALLOWED_ORIGINS: "https://a.example/path" }, /ALLOWED_ORIGINS/],
    [{ IDLE_TIMEOUT_MS: "10" }, /IDLE_TIMEOUT_MS/],
    [{ MAX_CONCURRENT_PATCHES: "0" }, /MAX_CONCURRENT_PATCHES/],
  ];
  for (const [over, msg] of bad) {
    assert.throws(() => loadConfig({ ...BASE, ...over }), (err: unknown) => err instanceof ConfigError && msg.test(err.message), JSON.stringify(over));
  }
});
