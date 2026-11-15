// Entry point: read the environment, start the tus server, stop cleanly on SIGINT/SIGTERM.
import { ConfigError, loadConfig } from "./config.js";
import { S3Client } from "./s3.js";
import { startServer } from "./server.js";
import { UploadStore } from "./store.js";

/** Starts the server from process.env. */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`configuration error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const s3 = new S3Client({
    endpoint: cfg.s3Endpoint,
    region: cfg.s3Region,
    bucket: cfg.s3Bucket,
    credentials: { accessKeyId: cfg.s3AccessKeyId, secretAccessKey: cfg.s3SecretAccessKey },
    forcePathStyle: cfg.s3ForcePathStyle,
    timeoutMs: cfg.s3TimeoutMs,
  });
  const running = await startServer(
    {
      s3,
      store: new UploadStore(cfg.stateDir),
      partSize: cfg.partSize,
      maxSize: cfg.maxUploadSize,
      idleTimeoutMs: cfg.idleTimeoutMs,
      maxConcurrentPatches: cfg.maxConcurrentPatches,
      allowedOrigins: cfg.allowedOrigins,
    },
    cfg.host,
    cfg.port,
  );
  console.log(`${new Date().toISOString()} tus endpoint ${running.url}/files (part size ${cfg.partSize} bytes)`);
  const stop = (): void => {
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
