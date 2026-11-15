// Environment configuration, validated up front (exit 2 on bad values).
import { MAX_PARTS, MIN_PART_SIZE } from "./server.js";

export interface Config {
  host: string;
  port: number;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3ForcePathStyle: boolean;
  s3TimeoutMs: number;
  partSize: number;
  maxUploadSize: number;
  stateDir: string;
  idleTimeoutMs: number;
  maxConcurrentPatches: number;
  allowedOrigins: string[];
}

const MIB = 1024 * 1024;

/** Raised for a missing or invalid setting. */
export class ConfigError extends Error {}

/** Reads an integer setting within [min, max]. */
function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

/** Reads a required, non-empty string setting. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new ConfigError(`${name} is required`);
  return v.trim();
}

/** Builds and validates the configuration from environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const s3Endpoint = required(env, "S3_ENDPOINT");
  let endpoint: URL;
  try {
    endpoint = new URL(s3Endpoint);
  } catch {
    throw new ConfigError("S3_ENDPOINT must be a URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new ConfigError("S3_ENDPOINT must be http(s)");
  const pathStyle = (env["S3_FORCE_PATH_STYLE"] ?? "true").toLowerCase();
  if (pathStyle !== "true" && pathStyle !== "false") throw new ConfigError("S3_FORCE_PATH_STYLE must be true or false");
  const partSize = int(env, "PART_SIZE", 8 * MIB, MIN_PART_SIZE, 64 * MIB);
  const maxUploadSize = int(env, "MAX_UPLOAD_SIZE", 5 * 1024 * MIB, 0, partSize * MAX_PARTS);
  const origins = (env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const o of origins) {
    if (!/^https?:\/\/[^/\s]+$/.test(o)) throw new ConfigError(`ALLOWED_ORIGINS entry is not an origin: ${o}`);
  }
  return {
    host: env["HOST"] ?? "127.0.0.1",
    port: int(env, "PORT", 8080, 0, 65535),
    s3Endpoint,
    s3Region: env["S3_REGION"] ?? "us-east-1",
    s3Bucket: required(env, "S3_BUCKET"),
    s3AccessKeyId: required(env, "S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    s3ForcePathStyle: pathStyle === "true",
    s3TimeoutMs: int(env, "S3_TIMEOUT_MS", 60_000, 1_000, 600_000),
    partSize,
    maxUploadSize,
    stateDir: env["STATE_DIR"] ?? "data/uploads",
    idleTimeoutMs: int(env, "IDLE_TIMEOUT_MS", 30_000, 1_000, 3_600_000),
    maxConcurrentPatches: int(env, "MAX_CONCURRENT_PATCHES", 16, 1, 1024),
    allowedOrigins: origins,
  };
}
