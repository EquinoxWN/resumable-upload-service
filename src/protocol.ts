// tus 1.0.0 header parsing and validation (pure functions, no I/O).

export const TUS_VERSION = "1.0.0";
export const TUS_EXTENSIONS = "creation,termination";
export const OFFSET_CONTENT_TYPE = "application/offset+octet-stream";
export const MAX_METADATA_BYTES = 4096;

/** Upload ids are server-generated UUIDs; anything else is refused before touching storage. */
export const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A header value parsed as a non-negative safe integer (digits only), or undefined. */
export function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Parses Upload-Metadata ("key base64,key2 base64"); returns an error string when invalid. */
export function parseMetadata(header: string | undefined): Record<string, string> | string {
  const out: Record<string, string> = {};
  if (header === undefined || header.trim() === "") return out;
  if (Buffer.byteLength(header) > MAX_METADATA_BYTES) return "Upload-Metadata too large";
  for (const pair of header.split(",")) {
    const parts = pair.trim().split(" ");
    const key = parts[0] ?? "";
    if (parts.length > 2 || !/^[\x21-\x7e]{1,128}$/.test(key) || key.includes(",")) {
      return "Upload-Metadata: invalid key";
    }
    if (Object.hasOwn(out, key)) return `Upload-Metadata: duplicate key ${key}`;
    const encoded = parts[1] ?? "";
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      return `Upload-Metadata: value of ${key} is not base64`;
    }
    out[key] = Buffer.from(encoded, "base64").toString("utf8");
  }
  return out;
}

/** Serializes metadata back into an Upload-Metadata header value. */
export function formatMetadata(meta: Readonly<Record<string, string>>): string {
  return Object.entries(meta)
    .map(([k, v]) => (v === "" ? k : `${k} ${Buffer.from(v, "utf8").toString("base64")}`))
    .join(",");
}

/** Content type to store on the S3 object: the client's `filetype` if it is a plain MIME type. */
export function contentTypeFrom(meta: Readonly<Record<string, string>>): string | undefined {
  const t = meta["filetype"] ?? meta["contentType"];
  return t !== undefined && /^[\w.+-]+\/[\w.+-]+$/.test(t) && t.length <= 127 ? t : undefined;
}
