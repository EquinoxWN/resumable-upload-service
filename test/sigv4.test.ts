import { test } from "node:test";
import assert from "node:assert/strict";
import { amzDate, canonicalQuery, EMPTY_SHA256, sha256Hex, sign, uriEncode } from "../src/sigv4.js";

// Example credentials and signatures published in the AWS S3 docs ("Signature Calculations for the
// Authorization Header: Transferring Payload in a Single Chunk").
const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const HOST = "examplebucket.s3.amazonaws.com";

test("AWS example: GET object with a Range header", () => {
  const { signature, authorization } = sign({
    method: "GET",
    path: "/test.txt",
    query: [],
    headers: { host: HOST, range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    service: "s3",
    credentials: AWS,
  });
  assert.equal(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(
    authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("AWS example: PUT object with an encoded key and a payload hash", () => {
  const body = "Welcome to Amazon S3.";
  const hash = sha256Hex(body);
  assert.equal(hash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const { signature } = sign({
    method: "PUT",
    path: "/" + uriEncode("test$file.text", true),
    query: [],
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host: HOST,
      "x-amz-content-sha256": hash,
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash: hash,
    region: "us-east-1",
    service: "s3",
    credentials: AWS,
  });
  assert.equal(signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("AWS example: GET bucket with a query string (sorted, encoded)", () => {
  const { signature } = sign({
    method: "GET",
    path: "/",
    query: [
      ["prefix", "J"],
      ["max-keys", "2"],
    ],
    headers: { host: HOST, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    service: "s3",
    credentials: AWS,
  });
  assert.equal(signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("encoding: unreserved kept, everything else percent-encoded, slash optional", () => {
  assert.equal(uriEncode("a-b_c.d~e", false), "a-b_c.d~e");
  assert.equal(uriEncode("a b/c+d=é", false), "a%20b%2Fc%2Bd%3D%C3%A9");
  assert.equal(uriEncode("dir/a b", true), "dir/a%20b");
  assert.equal(canonicalQuery([["uploadId", "x/y"], ["partNumber", "2"], ["uploads", ""]]), "partNumber=2&uploadId=x%2Fy&uploads=");
});

test("signing refuses a missing or malformed x-amz-date; amzDate formats UTC", () => {
  const base = { method: "GET", path: "/", query: [], payloadHash: EMPTY_SHA256, region: "us-east-1", service: "s3", credentials: AWS };
  assert.throws(() => sign({ ...base, headers: { host: HOST } }), /x-amz-date/);
  assert.throws(() => sign({ ...base, headers: { host: HOST, "x-amz-date": "2013-05-24" } }), /x-amz-date/);
  assert.equal(amzDate(new Date(Date.UTC(2013, 4, 24, 1, 2, 3, 456))), "20130524T010203Z");
});
