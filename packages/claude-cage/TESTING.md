# Testing Claude Cage

Run from `packages/claude-cage`:

```sh
npm test
npm run load-test
npm run test:upstream
npm run test:wired
npm pack --dry-run
```

No check uses a real Claude account or model request.

## Deterministic suite

`npm test` covers:

- Fragmented UTF-8 NDJSON, truncated and oversized frames, sliced writes, and backpressure.
- Compact text, thinking, redacted-thinking, and fragmented tool-call event reconstruction.
- Shared Pi `partial` identity and linear wire growth for thousands of thinking deltas.
- One sequential stdio service, status/models, cancellation, timeout, bad transcript hashes, and EOF cleanup.
- One persistent Cage process per Pi runtime, full/append transcript transfer, history reset, clean cancellation, no duplicate retry, fatal disconnect latching, and setup reservation.
- Fresh v2 installation safety, marker-owned v1 replacement, foreign/symlink refusal, and old-daemon stop failure before deletion.

`npm run load-test` loads the production extension in Pi without opening Cage or contacting Claude.

## Installed pinned-upstream acceptance

`npm run test:upstream` installs the guest into a temporary HOME. It fetches the pinned `pi-claude-code` revision and locked npm dependencies, then launches the installed `service.mjs --stdio` with a fake Claude CLI and local loopback model.

It verifies native tool-result replay, warm continuation, relay diagnostics, tool IDs, billing rejection, stdout-only rejection, cancellation, and worker cleanup. It does not read real credentials.

The test needs network access for GitHub and npm. For an offline run, set both:

```sh
PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO=/path/to/pi-claude-code.git
PI_CLAUDE_CAGE_TEST_NPM_CACHE=/path/to/populated/npm-cache
```

## Real Cage Wired mock acceptance

`npm run test:wired` is explicit. It requires one already-running non-base Wired VM. It sends temporary fixture files to the VM but installs no service and makes no Claude or Anthropic request.

Optional path overrides:

```sh
CAGE_TEST_EXECUTABLE=/absolute/path/to/cage \
CAGE_TEST_CONFIG=/absolute/path/to/config.json \
npm run test:wired
```

The test verifies:

- Persistent stdio operation and transcript append.
- 5,000 thinking deltas with bounded linear wire growth.
- An inline request and response larger than 32 MiB, below the 256 MiB limit.
- Tool-call identity.
- Active-turn abort when host stdin disappears.
- Guest service, mock Claude descendant, and temporary-directory cleanup.

## Media and release gates

From the repository root:

```sh
node scripts/capture-package-media.mjs claude-cage
npm test
npm run load-test
npm pack ./packages/claude-cage --dry-run
npm pack --dry-run
```

Inspect `docs/package-media-gallery.html` after media capture. The package screenshot and GIF use the deterministic mock model. Real login, account policy, billing, and egress require a separately authorized live acceptance and are not part of these gates.
