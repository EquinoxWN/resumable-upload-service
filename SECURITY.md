# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**Security > Report a vulnerability** on this repository
(`https://github.com/EquinoxWN/resumable-upload-service/security/advisories/new`). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You will get an answer
within 7 days. Fixes are released as soon as they are ready, and you are credited unless you ask
not to be.

## Supported versions

This project is pre-1.0. Only the latest commit on `main` receives fixes.

## Scope

- **In scope:** Reading or writing files outside `STATE_DIR` through upload ids or headers, writing to
  another upload, growing server memory or disk without limit from one connection, corrupting a stored
  object, and S3 credential or signature handling.
- **Out of scope:** Authentication of uploaders (M1 expects an auth proxy in front), load from many
  legitimate clients, and abandoned multipart uploads before the M3 cleanup (use a bucket lifecycle
  rule).

## How this repository protects itself

- Every GitHub Action is pinned to a full commit SHA, and workflows run with read-only
  permissions and without persisted credentials.
- Dependabot update pull requests are paused (`open-pull-requests-limit: 0`) so the repository keeps a single `main` branch; dependencies are updated by hand and checked by the CI audit.
- CI runs lint, tests and a known-vulnerability check (npm audit) on every push and pull request.
- The server has no runtime dependencies; test credentials in the repository are placeholders.
