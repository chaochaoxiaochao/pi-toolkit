# Claude Cage guest

The guest keeps the pinned [pi-claude-code](https://github.com/earendil-works/pi-claude-code/tree/d5b5e04c314d3452d357174d16d10dda34daa2d2) adapter and its warm-worker cache in one Node process. The adapter uses the official Claude Code CLI. Pi still owns conversation history and tool execution. The guest does not implement authentication or copy credentials.

## Requirements and installation

Use a Linux Cage guest with a working `systemd --user` manager. The same guest Unix user must install the service, run the client and own the Claude Code login. The guest needs Bash, GNU tar/coreutils, Git, Node.js 22.19.0 or later, and npm. Setup needs access to GitHub and the npm registry. It does not install or start the Claude Code CLI or authenticate an account.

From this repository, create the gzip tarball with the following **root-level regular files**. `install.sh` is the command, not an archive member. Do not put a `guest/` prefix on the members or include `node_modules`.

```bash
guest=packages/claude-cage/guest
tar -C "$guest" -czf /tmp/pi-claude-cage-guest.tar.gz \
  client.mjs service.mjs protocol.mjs package.json package-lock.json \
  pi-claude-cage.service pi-claude-cage.socket
cage run --workdir /tmp -- bash -c "$(<"$guest/install.sh")" \
  < /tmp/pi-claude-cage-guest.tar.gz
```

The installer prints the absolute client path in the guest. It installs into `~/.local/share/pi-claude-cage` and installs both unit files into `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. It refuses an unrelated directory, a symlink, or an unknown or modified unit with the same name. Reinstallation requires the original installation marker. The socket is enabled immediately. The daemon starts on the first socket connection and remains running afterward. The socket is `%t/pi-claude-cage/service.sock`, with directory mode `0700` and socket mode `0600`. `%t` is the guest user manager's runtime directory, normally `/run/user/<uid>`. The client uses the guest `XDG_RUNTIME_DIR` or that default.

Setup fetches revision `d5b5e04c314d3452d357174d16d10dda34daa2d2` and installs `@earendil-works/pi-ai@1.6.0` and its locked transitive dependencies with `npm ci --ignore-scripts`. The upstream `src/` and `LICENSE` are copied unmodified into `upstream/`. The service loads the source with `node --experimental-transform-types` **outside** `node_modules`; Node does not transform TypeScript inside `node_modules`. No Pi TUI or coding-agent runtime is required in the guest. An update resets warm workers. If systemd activation fails during a reinstall, the installer prints where it kept the previous files.

From a guest shell, inspect or restart the service without making a model request:

```sh
systemctl --user status pi-claude-cage.socket pi-claude-cage.service
journalctl --user -u pi-claude-cage.service
systemctl --user restart pi-claude-cage.service
```

### CLI and account policy

Review the upstream adapter and current Claude Code terms before running the CLI or connecting a real account. Only do so with explicit authorization. Sign in using the official Claude Code CLI inside the guest, not through this bridge. The bridge does not change which accounts, plans, models or usage limits Claude permits. It does not retry by switching accounts, accept credentials from the host, or pass through an opt-in to usage credits. The pinned upstream billing guard remains active. It can report usage-credit charging *after* Claude has processed a request; it cannot guarantee no charges or account restrictions. Model discovery uses the upstream CLI catalog probe, which does not generate a response but can contact Claude's services and use normal catalog telemetry.

The service looks for `claude` alongside Node, in `~/.local/bin`, or on the standard system path. To use another installation, put an absolute `PI_CLAUDE_CODE_COMMAND` in the guest-local `~/.config/pi-claude-cage/environment` and restart the service. This file can also set an absolute `PI_CLAUDE_CODE_CONFIG_DIR` for the guest CLI's own configuration or upstream discovery privacy switches. Do not put API keys or tokens in this file. The service rejects conflicting Claude auth or backend overrides from the guest environment and does not pass unrelated environment variables to the CLI. Settings in a socket request cannot change the executable, credentials, backend or working directory.

Do not install with `sudo` or point `HOME` at another account's login. The unit uses systemd's `%h`, not the installer's shell override for `HOME`. If you set `XDG_CONFIG_HOME`, use the user manager's configured directory for the units. The service environment file still lives under `%h/.config/pi-claude-cage/`. Shell startup files and shell-only login settings do not apply to a socket-activated service. If the CLI login relies on a keyring or session bus, it must be accessible to that guest user in the user manager's environment. An interactive `claude auth status` alone does not establish that the service can use that login.

## Host protocol

Launch exactly one proxy per request:

```sh
cage run --workdir /tmp -- node /absolute/guest/path/client.mjs
```

Read the first stdout line, exactly `{"type":"ready","version":1}`. This is a proxy handshake, not a login or service-health result. Send one JSON object followed by a newline. Keep stdin open until the response is terminal. A pipeline that closes stdin immediately after writing the request **cancels** it.

| Operation | Request fields besides `id` and `op` | Terminal response |
| --- | --- | --- |
| `status` | None | `value`: `{available, loggedIn, subscription, plan}`. `plan` can be `null`. |
| `models` | None | `value`: Upstream Pi `Model[]`. The host registers these under its provider/API IDs. |
| `turn` | `sessionId`, complete Pi `model`, Pi transcript `context: {messages}`, optional `options` | Upstream Pi `event` frames, ending with one `done` or `error` event. |
| `close` | `sessionId` | `value`: `null`. Cancels a running turn for that session and releases its warm worker. |

`id` is a nonempty string (up to 256 characters) or a safe integer. A session ID is a nonblank string of at most 256 characters. Use a different session ID for each independent Pi session. Send the same model ID, provider and API as in the Pi assistant history; the guest does not rewrite those identifiers. Do not serialize host credentials or environment variables. The guest only forwards `reasoning`, `maxTokens`, `cacheRetention` and a positive `timeoutMs` option. The default and maximum turn deadline is 180 seconds.

For Pi 1.6, include the prompt and initial tool declarations in the leading `system` message (`content` and `toolsAdded`). Do not send top-level `context.systemPrompt` or `context.tools`. The guest calls upstream's transcript stream directly. An upstream stdout-only test at the pinned revision uses the older context fields, but that test does not check the outgoing prompt or tool definitions.

Each response is `{id,type:"value",value}`, `{id,type:"event",event}`, or `{id,type:"error",message}`. The latter is a terminal guest/transport failure. Send `{id,type:"cancel"}` or close stdin to abort. The guest reclaims failed or cancelled workers but does not clear a successful session on ordinary connection completion. It rejects overlapping turns for the same session. Each protocol line may be at most 32 MiB. No network port or shared credential file is required by the host.

Production accepts `done` only if that turn's upstream `claude-code.turn-relay` diagnostic reports exactly one upstream request. A CLI response on stdout alone is not a successful turn, including a response to a Pi tool result. The guest fails the turn and discards the worker. This check does not change the upstream billing guard or prove that a request incurred no charge.

## Verification without an account

```sh
node --test packages/claude-cage/guest/*.test.mjs
npm --prefix packages/claude-cage run test:upstream
```

The first command tests local sockets and client subprocesses with a mock adapter. The second creates its own archive and temporary `HOME`, tests refusal and reinstall with a `systemctl` stub, and enables the installed guest test under `systemd-socket-activate`. That test runs the pinned upstream adapter and its real loopback turn relay. A test-only preload redirects the relay's HTTPS request to a local model fixture. The test covers tool IDs and cold replay, warm reuse, cancellation, the upstream usage-credit guard, and rejection of a stdout-only tool-result continuation. It does not use a real CLI login or make a cloud model request.

Installation normally fetches the pinned source from GitHub and the locked packages from npm. For a fully offline run, set both `PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO` to a local Git repository containing the pinned commit and `PI_CLAUDE_CAGE_TEST_NPM_CACHE` to an npm cache populated with the locked dependencies. The script uses and cleans up a temporary copy of the npm cache data. These are test inputs only.
