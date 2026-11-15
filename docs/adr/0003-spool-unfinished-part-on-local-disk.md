# ADR 0003: Spool the unfinished part on local disk

- **Status:** Accepted

## Context

tus lets a client send any number of bytes per `PATCH`, but S3 needs every part except the last to be
at least 5 MiB, and the parts must be listed in order at completion. When a `PATCH` ends (normally,
by a dropped connection, or because S3 refused a part) the server usually holds a tail that is not a
full part yet. Those bytes have been received, so tus requires them to count in `Upload-Offset`.

Options: (a) keep the tail in memory (lost on restart, and memory grows with idle uploads);
(b) store it in S3 as a separate small object, as tusd's S3 store does (survives node loss, costs two
extra S3 requests per `PATCH`); (c) write it to a spool file next to the upload's info file.

## Decision

Option (c) for M1: the tail goes to `<STATE_DIR>/<id>.spool` (temporary file, fsync, rename), and the
info file records how many of its bytes belong to the upload. The next `PATCH` reads the spool into the
part buffer first. A part is recorded in the info file before the spool is removed, and the info file
is authoritative: bytes in the spool beyond the recorded size are ignored.

## Consequences

- No bytes are lost on a drop, stall, S3 outage or server restart, with one local write per `PATCH`
  instead of extra S3 requests; memory stays at one part buffer per running `PATCH`.
- An upload is tied to the node that holds its state: several nodes need sticky routing by upload id,
  and losing the node's disk loses the unfinished uploads (finished objects are in S3). Moving the
  info and spool to S3 (option b) or a shared store is the path when multi-node is needed.
- Abandoned uploads leave a spool file of at most one part; M3's cleanup removes them with their
  multipart uploads.
