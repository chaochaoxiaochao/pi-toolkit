# Claude Cage guest

The guest service loads pinned [pi-claude-code](https://github.com/earendil-works/pi-claude-code/tree/0665b571fe36e4faa894a57c20c2c0be047f3e11) code in one session-owned Node process. That adapter owns Claude Code launch, warm continuation, cold transcript replay, tool mapping, billing checks, relay validation, and the request-wide cache-breakpoint limit. Pi remains the transcript owner and executes tools on the host.

## Requirements and installation

The guest needs Bash, GNU tar/coreutils, Git, Node.js 22.19 or later, npm, and official Claude Code. A systemd user manager is not required for v2.

The host setup command sends an archive containing these root-level regular files:

```sh
guest=packages/claude-cage/guest
tar -C "$guest" -czf /tmp/pi-claude-cage-guest.tar.gz \
  service.mjs protocol.mjs package.json package-lock.json
CLAUDE_CAGE_CONFIG=/absolute/host/config.json \
  /absolute/host/cage run --workdir /tmp -- \
  bash -c "$(<"$guest/install.sh")" \
  < /tmp/pi-claude-cage-guest.tar.gz
```

The installer writes `~/.local/share/pi-claude-cage/service.mjs` inside the VM. It stages and validates the complete v2 tree before replacement. It refuses an unrelated directory, an unknown marker, or a symlink.

When the destination has the exact v1 installation marker, the installer:

1. Validates the new staged v2 tree.
2. Stops and disables the old `pi-claude-cage.socket`.
3. Stops the old `pi-claude-cage.service`.
4. Removes the exact old service, socket, and bridge environment files.
5. Replaces the marker-owned v1 directory with v2.

A failed old-service stop leaves the v1 installation in place. Unknown or foreign paths fail before deletion. V2 installs no user units and does not use `~/.config/pi-claude-cage/environment`.

Setup fetches revision `0665b571fe36e4faa894a57c20c2c0be047f3e11` and installs the locked `@earendil-works/pi-ai@1.6.0` dependency tree with scripts disabled. The revision is the exact head of upstream PR #41 and is based directly on the previous pin `d5b5e04c314d3452d357174d16d10dda34daa2d2`. It caps outgoing requests at four `cache_control` blocks. Upstream `src/` and `LICENSE` are copied unmodified into `upstream/`. The service loads TypeScript with the installed Node symlink and `--experimental-transform-types`.

## Claude account policy

Review the upstream adapter and current Claude Code terms before connecting an account. Sign in with official Claude Code inside the guest. The bridge does not copy credentials, select an account, switch accounts, or enable usage credits.

The service finds `claude` beside Node, in `~/.local/bin`, or on the standard path. Use official Claude configuration under `~/.claude`. V2 intentionally has no bridge-specific command or environment override file. Conflicting Anthropic auth or alternate backend variables are rejected or removed before Claude Code starts.

The bridge preserves the upstream billing guard. It can report usage-credit charging after Claude has processed a request. It cannot guarantee that a disconnected request was not billed.

## Host launch and protocol

Each Pi runtime launches one service lazily:

```sh
CLAUDE_CAGE_CONFIG=/absolute/host/config.json \
  /absolute/host/cage run --workdir /tmp -- \
  env -u NODE_OPTIONS -u NODE_PATH -u LD_PRELOAD -u LD_LIBRARY_PATH -u LD_AUDIT \
  /home/guest/.local/share/pi-claude-cage/node \
  --experimental-transform-types \
  /home/guest/.local/share/pi-claude-cage/service.mjs --stdio
```

The guest emits `{"type":"ready","version":2}` after any Cage preamble. The host then uses bounded UTF-8 NDJSON frames over the same stdin and stdout. Only one operation can be active. Request IDs are increasing positive integers.

| Operation | Request | Terminal response |
| --- | --- | --- |
| `status` | `{id, op:"status"}` | `{id, type:"value", value:{available,loggedIn,subscription,plan}}` |
| `models` | `{id, op:"models"}` | `{id, type:"value", value:Model[]}` |
| `turn` | `{id, op:"turn", model, transcript, options}` | Compact `{id,type:"event",event}` frames ending in `done` or `error`, or an operation error frame |
| cancel | `{type:"cancel", id}` | Aborts the matching active operation; the service confirms cleanup with a terminal error frame |

`transcript` is either:

```json
{ "mode": "full", "messages": [] }
```

or:

```json
{ "mode": "append", "baseHash": "sha256", "messages": [] }
```

The first turn and any history reset use `full`. Normal continuations use `append` only when the host's known prefix matches the guest's committed base. The guest reconstructs the full Pi transcript before calling unchanged `streamClaudeCode()`. The bridge hash only reduces Host-to-VM transfer; upstream continuation hashes remain authoritative for Claude Code reuse.

The service accepts `reasoning`, `maxTokens`, `cacheRetention`, and a positive `timeoutMs`. The maximum turn timeout is 20 minutes. A logical frame or reconstructed transcript can be at most 256 MiB. Writes are sliced and wait for stdio backpressure.

A successful turn commits its input base only after an authoritative `done`, including `toolUse`. Cancellation, timeout, provider error, and cleanup failure invalidate the base, so the next turn must use `full`. Closing stdin aborts the active turn, closes Claude descendants, and exits the service.

A fatal protocol error, bad transcript base hash, unexpected stdio loss, or uncertain outcome closes the connection. The host does not reconnect or replay the request. The user must run `/reload`.

## Verification without an account

From the repository root:

```sh
npm --prefix packages/claude-cage test
npm --prefix packages/claude-cage run test:upstream
npm --prefix packages/claude-cage run test:wired
```

The installed-upstream test creates a temporary HOME, installs the exact pinned adapter, and uses a fake Claude CLI plus a loopback HTTP model. It covers native tool-result replay, warm continuation, billing rejection, stdout-only rejection, cancellation, and cleanup.

The Wired test is explicit and uses an already-running real Cage VM with a mock model only. It checks one persistent stdio process, transcript append, 5,000 thinking deltas, payloads above 32 MiB, and descendant cleanup after host stdin disappears. Neither test reads a real Claude login or contacts Anthropic.

For a fully offline installed-upstream run, set both `PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO` to a local Git repository containing the pinned commit and `PI_CLAUDE_CAGE_TEST_NPM_CACHE` to a populated npm cache.
