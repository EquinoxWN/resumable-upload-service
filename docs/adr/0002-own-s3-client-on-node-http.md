# ADR 0002: Own SigV4 S3 client on node:http instead of the AWS SDK and Fastify

- **Status:** Accepted

## Context

The service needs six S3 calls (CreateMultipartUpload, UploadPart, CompleteMultipartUpload,
AbortMultipartUpload, PutObject, Head/Get/DeleteObject) and full control over a raw request body:
when it is read, how backpressure works, and what happens to the bytes when the client drops. The
scaffold named Fastify, and the usual S3 choice is `@aws-sdk/client-s3`.

## Decision

- Implement SigV4 signing (`src/sigv4.ts`) and a small S3 client (`src/s3.ts`) on `node:crypto` and
  `node:http(s)`, with explicit per-attempt deadlines, bounded retries with jittered backoff, and
  response size limits.
- Serve tus directly on `node:http`; the body is read with `req.iterator({ destroyOnReturn: false })`
  so an error answer can still be sent after the handler stops reading.
- Test the signing against the example signatures in the AWS S3 documentation, run every test against
  a fake S3 that recomputes each request's signature and enforces S3's multipart rules, and run an
  end-to-end check against moto, an independent S3 implementation.

## Consequences

- No runtime dependencies (`npm audit` covers TypeScript and `@types/node` only), and the retry,
  timeout and idempotency behaviour is visible in about 250 lines.
- The service carries the risk of S3 compatibility gaps the SDK would have absorbed (checksum headers,
  virtual-hosted addressing quirks, S3 Express). Only path-style and virtual-hosted URLs with
  header-based SigV4 are supported, and only moto has been tested end to end; MinIO and AWS S3 are
  not yet run.
- Fastify's plugins (CORS, rate limiting, logging) are not available; M1 implements the small CORS
  part itself. If routing grows beyond tus, moving the handler under Fastify with a raw-body content
  type parser remains possible because the handler is a plain `(req, res)` function.
