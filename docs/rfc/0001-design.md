# RFC 0001: resumable-upload-service design

- **Status:** Accepted (M1 built)
- **Author:** EquinoxWN
- **Created:** 2026-11-14

## Problem

A 2 GB upload over a mobile or train connection fails at 99% and starts again from zero. Two things
cause the waste: plain HTTP uploads have no way to ask "how much did you get?", and servers that
buffer the whole request (or write it to local disk before moving it to object storage) cannot
accept many large uploads at once. The users are teams whose own users send large files (video,
datasets, backups) and who store them in S3 or an S3-compatible store.

## Goals

- Clients upload in chunks using the tus 1.0.0 protocol; after a dropped connection they ask for the
  offset and continue (M1).
- Chunks stream straight into S3 multipart uploads, so the server never holds a whole file in memory
  (M1).
- Checksums verify each chunk and the final file; size and content-type limits are enforced (M2).
- Completed uploads go to a worker that scans them with ClamAV and generates thumbnails (M2).
- Downloads use short-lived presigned URLs, and abandoned uploads are cleaned up automatically (M3).
- Tests cut connections mid-upload on a simulated slow network and verify resumption and integrity (M3).

### Critical-to-quality measures (Define)

| CTQ | Target | M1 measurement |
|---|---|---|
| Integrity | The stored object equals the uploaded bytes in every test and run | SHA-256 of the S3 object compared in tests, the moto run and the benchmark |
| Nothing received is lost | After a drop, stall or S3 failure, `Upload-Offset` counts every byte the server read | Drop, stall and outage tests compare `HEAD` to the bytes sent |
| Bounded memory | Server memory does not grow with file size | `make bench`: peak RSS at 32, 128 and 256 MiB with 5 MiB parts |
| S3 rules respected | Every part except the last is exactly `PART_SIZE` (5 MiB minimum) | Fake S3 rejects short parts (`EntityTooSmall`); moto run with 5 MiB parts |
| Retry safety | Retried S3 calls and repeated requests have one effect | Tests for re-sent parts, lost Complete answers, 409 on stale offsets |

## Non-goals

- Running as a hosted production service.
- Several server nodes sharing one upload in M1 (state is on one node's disk; see ADR 0003).
- Authentication of uploaders: the service is meant to sit behind the application's own auth
  proxy or gateway in M1.
- Downloads, scanning and thumbnails before M2/M3.

## Proposed design

See `docs/architecture.png` for the full roadmap. M1 components:

- **tus handler** (`src/server.ts`): `node:http` request handler for tus core, creation and
  termination. Upload ids are server-generated UUIDs. A per-upload lock allows one `PATCH` at a
  time (423 otherwise); a global limit caps running `PATCH` requests (503).
- **Part buffer**: each `PATCH` gets one buffer of `PART_SIZE` bytes. The body is read with an async
  iterator; when the buffer fills, it is sent as the next `UploadPart` and recorded before the next
  chunk is read, so TCP backpressure slows the client instead of growing memory.
- **Upload state** (`src/store.ts`): one JSON info file per upload (length, metadata, S3 UploadId,
  parts with ETags and sizes, spool size) and one spool file for the unfinished part. Writes go to a
  temporary file, are fsynced and renamed. `Upload-Offset` is the sum of recorded parts plus the
  recorded spool size. Order of writes: part to S3, then info; spool file, then info. A crash
  between the two leaves the info file behind the truth, so the client re-sends bytes the server
  already has, which is safe because a re-sent part number overwrites.
- **S3 client** (`src/s3.ts`, `src/sigv4.ts`): SigV4-signed requests over `node:http(s)` with a
  deadline per attempt and up to 3 attempts with jittered exponential backoff for throttling, 5xx
  and transport errors; 4xx are not retried. A `CompleteMultipartUpload` answered `NoSuchUpload` on
  retry is checked with `HeadObject`. Zero-length uploads use one `PutObject`.
- **Client** (`src/client.ts`): creates an upload, sends fixed-size chunks, and after any failure
  waits, asks `HEAD` for the offset and continues, up to `maxRetries` failures in a row.

## Alternatives considered

| Option | Why not (yet) |
|---|---|
| tusd (Go) with its S3 store | Mature and the reference implementation, but the point of this repository is to build and measure the mechanism; tusd's S3 store is the design reference (it also stores the unfinished part separately). |
| Buffer each upload to local disk, copy to S3 when complete | Simple and survives restarts, but needs disk equal to all in-flight uploads, doubles I/O, and delays the object until the copy finishes. |
| Presigned multipart URLs, client uploads parts straight to S3 | Takes the server out of the data path, but resumption, part sizing and part bookkeeping move into every client, and the tus ecosystem (tus-js-client, Uppy) cannot be used as is. Kept as an option next to M3's presigned downloads. |
| AWS SDK v3 (`@aws-sdk/client-s3`) and Fastify | Well tested, but they add many runtime packages for six S3 calls and a raw request body; see ADR 0002. |

## Measurement plan

- **Measure:** `make test` (59 tests), `npm run e2e:s3` against moto with 5 MiB parts, and
  `make bench`, which runs the server in its own process with `--expose-gc` and samples its RSS and
  live heap plus buffers every 50 ms while 32, 128 and 256 MiB are uploaded.
- **Analyze:** memory must not grow with file size; every stored object's SHA-256 must match.
- **Control:** CI runs lint, tests and `npm audit` on every push and the moto end-to-end job; the
  fake S3 enforces S3's part rules so a regression in part sizing fails the tests.

## Milestones

- **M1:** Clients upload in chunks using the tus protocol. Chunks stream straight into S3 multipart uploads, so the server never holds a whole file in memory.
- **M2:** Checksums verify each chunk and the final file. Completed uploads go to a worker that scans them with ClamAV and generates thumbnails.
- **M3:** Downloads use short-lived presigned URLs, and abandoned uploads are cleaned up automatically. Tests cut connections mid-upload on a simulated slow network and verify resumption and integrity.

## Risks and open questions

- State on local disk ties an upload to one node; a load balancer needs sticky routing by upload id
  until the state moves to shared storage (ADR 0003).
- Abandoned multipart uploads keep their parts in S3 until M3's cleanup; a bucket lifecycle rule
  (`AbortIncompleteMultipartUpload`) is the stopgap.
- A retried `CreateMultipartUpload` whose first answer was lost leaves an empty multipart upload
  behind (same stopgap).
- The SigV4 code is checked against the AWS documentation's examples, the fake S3 and moto, but not
  yet against AWS S3 or MinIO itself.
