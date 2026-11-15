// Upload state on local disk: one JSON info file and one spool file (the unfinished part) per upload.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { UPLOAD_ID } from "./protocol.js";

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadInfo {
  id: string;
  length: number;
  metadata: Record<string, string>;
  /** S3 object key. */
  key: string;
  /** S3 multipart UploadId; empty for zero-length uploads, which use one PutObject. */
  s3UploadId: string;
  parts: StoredPart[];
  /** Bytes of the spool file that belong to the upload (the file may hold a stale tail). */
  spoolSize: number;
  completed: boolean;
  /** Creation time, ISO 8601 UTC. */
  createdAt: string;
}

/** Bytes the server holds durably: uploaded parts plus the spooled tail. */
export function offsetOf(info: UploadInfo): number {
  return info.parts.reduce((n, p) => n + p.size, 0) + info.spoolSize;
}

/** Checks a parsed info file before it is trusted. */
function isUploadInfo(v: unknown): v is UploadInfo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    Number.isSafeInteger(o["length"]) &&
    typeof o["metadata"] === "object" &&
    o["metadata"] !== null &&
    typeof o["key"] === "string" &&
    typeof o["s3UploadId"] === "string" &&
    Array.isArray(o["parts"]) &&
    (o["parts"] as unknown[]).every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        Number.isInteger((p as StoredPart).partNumber) &&
        typeof (p as StoredPart).etag === "string" &&
        Number.isSafeInteger((p as StoredPart).size),
    ) &&
    Number.isSafeInteger(o["spoolSize"]) &&
    typeof o["completed"] === "boolean" &&
    typeof o["createdAt"] === "string"
  );
}

/** File-backed store; every write goes to a temporary file first and is renamed into place. */
export class UploadStore {
  /** Uses (and creates) the given directory. */
  constructor(private readonly dir: string) {}

  /** Creates the state directory. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Path of one of an upload's files; refuses ids that are not server-generated UUIDs. */
  private path(id: string, ext: "json" | "spool"): string {
    if (!UPLOAD_ID.test(id)) throw new Error("invalid upload id");
    return join(this.dir, `${id}.${ext}`);
  }

  /** Writes a file atomically (temporary file, fsync, rename). */
  private async atomicWrite(target: string, data: Buffer | string): Promise<void> {
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Saves an upload's info. */
  async save(info: UploadInfo): Promise<void> {
    await this.atomicWrite(this.path(info.id, "json"), JSON.stringify(info));
  }

  /** Loads an upload's info, or undefined if it does not exist. */
  async load(id: string): Promise<UploadInfo | undefined> {
    if (!UPLOAD_ID.test(id)) return undefined;
    let text: string;
    try {
      text = await readFile(this.path(id, "json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isUploadInfo(parsed) || parsed.id !== id) throw new Error(`corrupt upload info for ${id}`);
    return parsed;
  }

  /** Replaces the spool file with the given bytes. */
  async writeSpool(id: string, data: Buffer): Promise<void> {
    await this.atomicWrite(this.path(id, "spool"), data);
  }

  /** Reads the first `size` bytes of the spool file. */
  async readSpool(id: string, size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0);
    const data = await readFile(this.path(id, "spool"));
    if (data.length < size) throw new Error(`spool for ${id} is shorter than recorded`);
    return data.subarray(0, size);
  }

  /** Removes the spool file (after its bytes went into a part). */
  async dropSpool(id: string): Promise<void> {
    await rm(this.path(id, "spool"), { force: true });
  }

  /** Removes every file of an upload. */
  async remove(id: string): Promise<void> {
    await rm(this.path(id, "spool"), { force: true });
    await rm(this.path(id, "json"), { force: true });
  }
}
