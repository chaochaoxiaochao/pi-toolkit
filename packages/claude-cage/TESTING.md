# Testing Claude Cage

Run from `packages/claude-cage`:

```sh
npm test
npm run load-test
npm run test:upstream
npm run test:wired
npm pack --dry-run
```

The commands above use no real Claude account or model request. Separately authorized live checks are recorded below and are not routine release gates.

## Deterministic suite

`npm test` covers:

- Fragmented UTF-8 NDJSON, truncated and oversized frames, sliced writes, and backpressure.
- Compact text, thinking, redacted-thinking, and fragmented tool-call event reconstruction.
- Shared Pi `partial` identity and linear wire growth for thousands of thinking deltas.
- One sequential stdio service, status/models, cancellation, timeout, bad transcript hashes, and EOF cleanup.
- One persistent Cage process per Pi runtime, full/append transcript transfer, history reset, clean cancellation, no duplicate retry, fatal disconnect latching, and setup reservation.
- Safe model projection: one-hour prompt-cache metadata is retained only for adaptive-thinking models; unsafe or unknown models do not enable Pi warming.
- Environment-selected long retention, explicit disabled-cache requests, warming usage with a large cache read and no large rewrite, and preemption by real turns, status/model requests, and setup.
- Fresh v2 installation safety, marker-owned v1 replacement, foreign/symlink refusal, and old-daemon stop failure before deletion.

`npm run load-test` loads the production extension in Pi without opening Cage or contacting Claude.

## Installed pinned-upstream acceptance

`npm run test:upstream` installs the guest into a temporary HOME. It fetches the pinned `pi-claude-code` revision and locked npm dependencies, then launches the installed `service.mjs --stdio` with a fake Claude CLI and local loopback model.

It verifies native tool-result replay, warm continuation, relay diagnostics, tool IDs, billing rejection, stdout-only rejection, cancellation, and worker cleanup. It also runs eight warm/cold, short/long-history, with/without-system-update request shapes against the installed pinned source and requires at most four request-level `cache_control` blocks. It does not read real credentials.

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

## Authorized real-cache acceptance

The deterministic and mock gates do not use a real Claude account. The separately authorized 2026-11-25 acceptance used the production route `Pi → claude-cage → Wired guest → Claude Code 2.1.331 → Anthropic`, with usage credits disabled.

The hidden warmer read 54,624 cached tokens and wrote none. The post-tool request read 54,624 and wrote 66. The immediate follow-up read 54,690 and wrote 29. This did not match the suspected upstream #34 cache-collapse signature.

The same run showed that replay writes remained one-hour writes even when the documented Claude Code five-minute setting was present. Therefore Cage exposes only the verified one-hour cache tier instead of causing Pi to refresh a one-hour cache every 4.5 minutes. Do not repeat this live acceptance without explicit authorization.

A later authorized real scenario used Haiku 5.5 for two complete 15-call tool loops, once with CacheWarmer disabled and once with `streaming`. Both immediate plain follow-ups read about 69,920 cached tokens and wrote 27, so #34 did not reproduce.

The same acceptance reproduced upstream #40 twice on the previous pin: an Opus 5.5 warm continuation after a Pi system-prompt section update returned `400 ... A maximum of 4 blocks with cache_control may be provided. Found 5.` with CacheWarmer both disabled and set to `streaming`; the following cold request succeeded. After pinning upstream PR #41 commit `0665b571fe36e4faa894a57c20c2c0be047f3e11` and redeploying the guest, both warm system-update requests completed. They read about 1,345 cached tokens and wrote 427, with no 400. CacheWarmer emitted no hidden refresh in these short runs.

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
