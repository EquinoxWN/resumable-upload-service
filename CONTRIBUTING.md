# Contributing

Thanks for helping. This is a TypeScript project; issues and pull requests are welcome.

## Set up and check your change

Needs Node.js 24+. Caches and scratch files stay in git-ignored folders inside the repo (`.tmp/`).

```bash
make setup   # install dependencies
make lint    # strict TypeScript type check
make test    # full test suite (local servers only)
make audit   # known-vulnerability check (as in CI)
make bench   # server memory while uploading 32, 128 and 256 MiB
```

`make e2e` runs the resumed-upload check against a real S3-compatible server; set the `S3_*`
variables from the README (CI uses moto 5.2.5).

A pull request is ready when `make lint` and `make test` pass and CI is green.

## Guidelines

- Keep each change focused; explain the problem it solves in the pull request.
- Add or update a test for every behaviour change, and update `docs/results/` when numbers change.
- Keep test uploads small; tests write only under `.tmp/` and clean up after themselves.
- Significant design changes need an ADR in `docs/adr/` (copy `0001` for the format).
- Keep function comments to one short phrase; let names and tests explain the rest.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT License](LICENSE).
