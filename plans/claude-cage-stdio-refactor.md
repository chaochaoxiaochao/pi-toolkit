# Claude Cage long-lived stdio refactor

## Context

`pi-claude-cage` currently starts a guest `client.mjs` for every operation. The client connects to a shared systemd-activated Unix-socket `service.mjs`. Long Claude thinking streams expose two transport defects: cumulative `partial` objects are repeatedly serialized, and ordinary writes do not honor backpressure. Full Pi transcripts, including MB-sized images and tool results, also cross the VM boundary on every model turn.

The intended outcome is a thinner topology that continues to reuse upstream `pi-claude-code` for transcript conversion, Claude CLI lifecycle, warm continuation/cold replay, loopback relay, streaming semantics, billing checks, and one-relayed-request validation.

A read-only Astra reviewer approved a lazy service-per-Pi stdio topology. It warned that cleanup after host loss must be witnessed and that transcript synchronization must remain connection-local rather than become a second persistent conversation store.

## Approach

### Process topology

- Each Pi extension runtime lazily starts one long-lived host Cage command.
- The host Cage executable runs `service.mjs --stdio` inside the selected VM.
- `service.mjs` imports the pinned upstream adapter and owns one stable upstream session ID.
- Remove production `client.mjs`, the Unix socket, and the systemd service/socket units.
- Permit one operation at a time on each connection. A main Pi and each Herdr child own independent connections and guest service processes.

### Transport

- Keep a bounded textual preamble only until a versioned `ready` line.
- After `ready`, keep one bounded NDJSON framing implementation over stdin/stdout. Raise the logical-frame ceiling, but stream each encoded line in bounded write slices rather than buffering it into the pipe at once.
- Read lines incrementally across arbitrary chunk and UTF-8 boundaries. Await `drain` in both directions.
- Cap a logical frame/request at 256 MiB.
- Treat a disconnect after request submission as unknown outcome. Never replay or switch provider automatically.
- Use a fixed 20-minute hard maximum turn deadline, while preserving shorter valid caller deadlines and Esc cancellation.
- Keep both the 20-minute deadline and 256 MiB logical-frame limit as protocol safety constants for this release, not new user configuration fields. A later release can add settings only if measured workloads require different bounds.
- Serialize host writes. If Esc arrives while a large request line is being written, finish that frame boundary, send the matching cancel, and keep reading through the authoritative cancellation/cleanup terminal within a short grace period. If the frame or cleanup cannot finish within the bound, close the connection as fatal. Never splice a cancel frame into an incomplete JSON line.

### Response events

- Keep upstream `streamClaudeCode()` unchanged.
- Encode cumulative upstream events as compact transport events: message start metadata, block start, delta, authoritative completed block, and terminal full `done`/`error`.
- Reconstruct one shared mutable Pi `partial` on the host before calling Pi hooks and pushing standard `AssistantMessageEvent` values.
- Preserve thinking signatures/redaction, tool IDs/names/arguments, usage, cost, diagnostics, response identity, and stop reason.

### Transcript synchronization

- Maintain transcript state only for the lifetime of the stdio connection.
- First turn or any non-prefix history sends `full`.
- A normal continuation sends `append` plus the guest-issued base hash.
- Compare the actual post-`onPayload` messages. Compaction, branch/history edits, system/tool changes, or reconnects produce a full sync.
- Guest verifies the base hash, reconstructs the complete Pi transcript, and still calls upstream with the complete `context.messages` array.
- Keep upstream worker continuation logic authoritative. The bridge hash controls Host-to-VM transfer only; upstream `tipHash` controls adapter-to-`claude -p` continuation.
- Hash mismatch fails before adapter/model invocation and closes the connection. No transcript is persisted or shared across Pi processes.
- Apply the 256 MiB ceiling to the reconstructed complete transcript as well as each wire frame, so a sequence of valid appends cannot grow an unsendable guest history.
- Keep a pending input base during a turn. Commit that exact post-`onPayload` input transcript on authoritative successful `done`, including `toolUse`. On error, timeout, or clean cancellation, discard both sides' candidate base so the next turn sends `full`. Do not predict or cache assistant/tool messages that Pi may add later.
- Compare immutable serialized wire values or per-message digests, never mutable Pi object identity.

### Setup and migration

- Change the host profile schema from `clientPath` to absolute guest `servicePath`.
- Give old profiles a precise manual migration error; do not guess or rewrite paths.
- `/claude-cage-setup` remains explicit and confirmed.
- Fresh installs no longer require a systemd user manager.
- During confirmed setup, automatically replace the old v1 installation without a general migration framework:
  - Fully stage and validate v2 before touching v1.
  - Treat the exact `pi-claude-cage guest installation v1` marker in a real, non-symlink install directory as ownership of that managed directory. An unmarked, foreign, or symlinked destination still fails closed.
  - Run `systemctl --user disable --now pi-claude-cage.socket` and stop `pi-claude-cage.service` before deleting the old files. This is the only reason a v1 upgrade needs the existing user manager; the user does not configure anything, and fresh v2 installs do not use systemd.
  - Remove the two exact old user-unit paths and the marked v1 install directory, run daemon-reload, then atomically move the already-validated v2 directory into place.
  - If the old service cannot be stopped, abort before deletion. Do not add checksum manifests, a general migrator, or a rollback subsystem.
- Do not retain the optional `~/.config/pi-claude-cage/environment` layer in the new design. Use the guest's normal Claude installation and official `~/.claude` settings. The bridge still strips auth/backend overrides and loader variables before launch.
- A fatal protocol error or unexpected disconnect permanently closes that extension runtime's connection owner. The current turn becomes a normal Pi assistant error, which Pi renders in its error color. Its message must start with a clear Cage connection failure and say that `/reload` is required. Status/models commands and later turns must also fail immediately with an error notification/message until reload.
- A confirmed setup may reset only a healthy idle owner. Setup reserves the same owner gate used by provider turns, closes that healthy connection, installs, then explicitly returns it to unopened state. Setup never clears a fatal latch; a fatal owner still requires `/reload`.

### Guest launch isolation

The host constructs a fixed Cage command; no arbitrary command is accepted from configuration:

- Run the installed `node` symlink beside `servicePath` with `--experimental-transform-types`.
- Run `service.mjs --stdio` from a private guest working directory.
- Remove `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and `LD_AUDIT` in the guest command **before Node starts**.
- Do not retain the old environment-file layer or shell-source guest files.
- After Node starts, `service.mjs` still rejects conflicting Claude auth/backend overrides and reduces the environment to the existing guest-local allowlist before importing or launching upstream code.

### Fatal boundary and reload policy

The connection becomes fatal only when the host can no longer trust the persistent transport or its connection-local transcript state:

- Cage process startup fails or exits before a valid ready handshake.
- Ready protocol/build version is incompatible.
- stdin/stdout closes unexpectedly, writes fail with EPIPE, or the Cage process exits while owned by the runtime.
- An inbound JSON frame, request ID, event transition, block index/type, terminal frame, or declared size is invalid.
- The peer sends an oversized frame. An outbound request that the host rejects before writing is a normal pre-submit operation error.
- Guest and host transcript base hashes disagree.
- The connection disappears after a model request is committed, leaving the outcome unknown.
- Cancellation, timeout, or shutdown cannot confirm guest operation and Claude-worker cleanup within the cleanup grace period.

Fatal handling:

- Abort the active local stream without executing a partial tool call.
- Stop/kill the owned Cage process with bounded escalation.
- Keep the owner in `fatal`; do not relaunch it or replay the request.
- Render one native Pi assistant error beginning `Claude Cage connection failed and is closed.` and ending `Run /reload before using Claude Cage again.` Do not add a custom renderer.
- Status/models commands use an error notification with the same reload instruction.
- Every later Cage turn fails immediately until Pi reload creates a new extension runtime and owner.

These operation failures are **not** connection-fatal when the protocol returns a valid authoritative terminal and cleanup completes:

- Normal Claude/provider error, usage-credit billing guard, rate limit, context overflow, or login/model-catalog failure.
- A request rejected before submission because it exceeds 256 MiB or has invalid allowed fields.
- A 20-minute turn timeout whose guest cancellation and worker cleanup are confirmed.
- User Esc cancellation whose guest cancellation and worker cleanup are confirmed.
- A transcript history change detected by the host before submission; it sends `full` instead of `append`.

User `/reload` is required after a fatal message, after editing `claude-cage.json`, and after updating the host package so Pi loads new extension code. A confirmed `/claude-cage-setup` is a planned reset: it closes an idle connection, installs the guest files, resets the owner explicitly, and does not by itself require another reload. Normal model errors, clean cancellation, clean timeout, status/login failures, and full transcript resynchronization do not require reload.

Setup and fatal reset are mutually exclusive: setup may perform the planned reset only while the owner is healthy and idle. It reserves the owner against provider turns during confirmation and installation. A fatal owner cannot be repaired by setup in the same runtime.

## Files to modify

- `packages/claude-cage/src/transport.ts` — long-lived connection owner, ready handshake, framed I/O, cancellation, shutdown, transcript transfer state.
- `packages/claude-cage/src/provider.ts` — compact event reconstruction and use of the shared connection.
- `packages/claude-cage/extensions/claude-cage.ts` — status/models/setup through the shared owner and planned setup reset.
- `packages/claude-cage/src/profile.ts` — `servicePath` schema and old-profile diagnostic.
- `packages/claude-cage/src/setup.ts` — service preflight/install confirmation without systemd.
- `packages/claude-cage/guest/protocol.mjs` — bounded incremental NDJSON protocol, backpressured sliced writes, compact event codec helpers.
- `packages/claude-cage/guest/service.mjs` — sequential stdio service, transcript cache, cancellation, upstream invocation and cleanup.
- `packages/claude-cage/guest/install.sh` — v2 file install and direct removal of a marker-owned v1 systemd installation after stopping it.
- Delete obsolete production files: `guest/client.mjs`, `guest/pi-claude-cage.service`, `guest/pi-claude-cage.socket`.
- Adapt fixtures and tests under `packages/claude-cage/tests/` and `packages/claude-cage/guest/`.
- Update `packages/claude-cage/README.md`, `guest/SETUP.md`, `TESTING.md`, `CHANGELOG.md`, root documentation, media scripts, and package-layout expectations as needed.

## Reuse

- Preserve `streamClaudeCode`, `closeClaudeProcesses`, `discoverClaudeModels`, `getClaudeStatus`, and `modelFromDiscovery` imports in `packages/claude-cage/guest/service.mjs`.
- Preserve the provider's model validation, safe failure/no-retry behavior, payload allowlist, billing behavior, and relay diagnostic check.
- Reuse the current setup archive/staging and pinned-upstream verification in `guest/install.sh`; replace only the runtime topology.
- Reuse the current installer's staging and pinned-upstream validation so v2 is complete before the marked v1 install is stopped and removed.
- Reuse the installed-upstream fake CLI and loopback model fixtures to verify upstream cold replay, warm continuation, tool IDs, billing rejection, and cleanup without a real account.
- Reuse the real Wired mock acceptance path; replace socket/client assertions with persistent stdio and descendant cleanup evidence.

## Steps

- [x] Define the public seams and add failing tests for the persistent connection and bounded stdio protocol.
- [x] Implement the framed codec and compact response event codec.
- [x] Implement `service.mjs --stdio` with one in-flight operation, cancellation, transcript full/append state, and witnessed shutdown.
- [x] Implement the host connection owner, reconstructed Pi event stream, and explicit fatal-state diagnostics that Pi renders in red.
- [x] Integrate status, model discovery, turns, setup reset, and session shutdown.
- [x] Migrate profile/setup/installer and remove obsolete socket/client production files.
- [x] Adapt pinned-upstream and Wired mock acceptance tests.
- [x] Update user and release documentation and regenerate affected media if the visible flow changes.
- [x] Run package and root release gates; do not contact a real Claude account.

## Verification

- Deterministic protocol fragmentation, UTF-8, exact bounds with injected small limits, truncated frames, slow readers, backpressure, cancellation at a blocked frame boundary, and request-over-limit rejection.
- Thousands of small thinking deltas produce near-linear wire bytes and preserve shared host `partial` identity.
- Thinking signatures/redaction and fragmented tool arguments survive reconstruction.
- One real request larger than 32 MiB but below 256 MiB, containing inline image/tool-result data, round-trips byte-for-byte.
- First turn sends full transcript; normal tool continuation sends append without repeating image bytes; compaction/history change sends full; bad base hash invokes upstream zero times.
- One host manager launches one Cage process for status, models, and multiple turns; concurrent operation fails visibly; fatal disconnect does not relaunch or retry.
- Graceful shutdown and abrupt host loss both produce guest service and Claude descendant cleanup evidence.
- Installer tests cover fresh v2 install, successful marked v1 automatic replacement, unmarked/foreign/symlink destination refusal before deletion, and old-service stop failure before deletion.
- `npm --prefix packages/claude-cage test`
- `npm --prefix packages/claude-cage run load-test`
- `npm --prefix packages/claude-cage run test:upstream`
- `npm --prefix packages/claude-cage run test:wired` with the mock model only; require evidence that abrupt host loss removes both the guest service and Claude descendant.
- `npm pack ./packages/claude-cage --dry-run`
- Root tests/load checks/pack if shared manifests, package layout, media, or root docs change.

## Confirmed decisions

- Remove the optional bridge-specific guest environment file. Keep official Claude configuration under `~/.claude` and use default CLI discovery.
- Use a 20-minute maximum model turn.
- Keep the 20-minute deadline and 256 MiB logical-frame/request ceiling as fixed safety constants in this release. Callers may request a shorter timeout.
- After a fatal protocol error or unexpected disconnect, require `/reload`. Show a prominent red Pi error that says the connection is closed and reload is required.
- Confirmed setup automatically stops and removes an exact marker-owned v1 systemd installation and installs v2. Unmarked, foreign, or symlinked destinations refuse without deleting files.
