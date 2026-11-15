// AWS Signature Version 4 for S3 requests (header-based auth), built on node:crypto.
import { createHash, createHmac } from "node:crypto";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  /** Path as sent on the wire (already percent-encoded, e.g. "/bucket/uploads/abc"). */
  path: string;
  /** Query parameters, unencoded. */
  query: ReadonlyArray<readonly [string, string]>;
  /** Headers to sign; must include host, x-amz-date and x-amz-content-sha256. */
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  region: string;
  service: string;
  credentials: Credentials;
}

/** Hex SHA-256 of a buffer or string. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** RFC 3986 percent-encoding as S3 expects (unreserved characters kept). */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) {
      out += ch;
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Sorted, encoded query string used both on the wire and in the canonical request. */
export function canonicalQuery(query: ReadonlyArray<readonly [string, string]>): string {
  return query
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Byte-order string comparison (the canonical request sorts by code point). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical request text for the given input. */
export function canonicalRequest(input: SignInput): { text: string; signedHeaders: string } {
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => cmp(a[0], b[0]));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const text = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    entries.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  return { text, signedHeaders };
}

/** Derived signing key for a date, region and service. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", "AWS4" + secret).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

/** Signature and Authorization header value for a request. */
export function sign(input: SignInput): { authorization: string; signature: string } {
  const amzDate = input.headers["x-amz-date"];
  if (amzDate === undefined || !/^\d{8}T\d{6}Z$/.test(amzDate)) {
    throw new Error("x-amz-date header (YYYYMMDDTHHMMSSZ) is required");
  }
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const { text, signedHeaders } = canonicalRequest(input);
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(text)].join("\n");
  const key = signingKey(input.credentials.secretAccessKey, date, input.region, input.service);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signature };
}

/** x-amz-date value (UTC) for a moment in time. */
export function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
