import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTypeFrom, formatMetadata, parseMetadata, parseNonNegativeInt, UPLOAD_ID } from "../src/protocol.js";

test("parseNonNegativeInt accepts plain digits only, within the safe range", () => {
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(parseNonNegativeInt("1048576"), 1048576);
  for (const bad of [undefined, "", "-1", "1.5", "1e3", " 1", "0x10", "abc", "99999999999999999"]) {
    assert.equal(parseNonNegativeInt(bad), undefined, String(bad));
  }
});

test("Upload-Metadata: pairs and empty values parse; round trip through formatMetadata", () => {
  const header = `filename ${Buffer.from("a b,c.txt").toString("base64")},empty,filetype ${Buffer.from("text/plain").toString("base64")}`;
  const meta = parseMetadata(header);
  assert.deepEqual(meta, { filename: "a b,c.txt", empty: "", filetype: "text/plain" });
  assert.deepEqual(parseMetadata(formatMetadata(meta as Record<string, string>)), meta);
  assert.deepEqual(parseMetadata(undefined), {});
  assert.deepEqual(parseMetadata("  "), {});
});

test("Upload-Metadata: invalid keys, values, duplicates and oversized headers are refused", () => {
  for (const bad of ["k v w", "k not*base64", "k YQ=", "a YQ==,a YQ==", "keÿy YQ==", "x".repeat(4097)]) {
    assert.equal(typeof parseMetadata(bad), "string", bad.slice(0, 20));
  }
});

test("content type comes from filetype only when it is a plain MIME type", () => {
  assert.equal(contentTypeFrom({ filetype: "image/png" }), "image/png");
  assert.equal(contentTypeFrom({ filetype: "text/html\r\nX-Evil: 1" }), undefined);
  assert.equal(contentTypeFrom({ filetype: "nonsense" }), undefined);
  assert.equal(contentTypeFrom({}), undefined);
});

test("upload ids must be v4 UUIDs (no path characters)", () => {
  assert.ok(UPLOAD_ID.test("3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f"));
  for (const bad of ["../etc/passwd", "3F2B8C1E-9D4A-4C6B-8E2F-1A2B3C4D5E6F", "3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f/..", ""]) {
    assert.equal(UPLOAD_ID.test(bad), false, bad);
  }
});
