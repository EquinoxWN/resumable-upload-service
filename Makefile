.PHONY: setup lint test bench e2e audit ci

setup:
	npm ci

# Strict TypeScript (noUncheckedIndexedAccess, exactOptionalPropertyTypes), no emit.
lint:
	npm run lint

# Unit tests plus real HTTP: tus server, S3 client and an in-process fake S3 on local ports.
test:
	npm test

# Server memory while uploading 32, 128 and 256 MiB with 5 MiB parts (data under .tmp/, removed after).
bench:
	npm run build
	node dist/src/bench.js 32
	node dist/src/bench.js 128
	node dist/src/bench.js 256

# Resumed upload against a real S3-compatible server; needs S3_* variables (see README).
e2e:
	npm run e2e:s3

# Known vulnerabilities in npm dependencies (high and critical fail).
audit:
	npm audit --audit-level=high

ci: setup lint test
