# Pi Claude Cage (experimental)

Use the host's Pi tools and build environment while Claude Code runs in a **running Linux Cage VM**. This optional provider does not replace the `claude-code` provider. The guest uses pinned [pi-claude-code](https://github.com/earendil-works/pi-claude-code/tree/d5b5e04c314d3452d357174d16d10dda34daa2d2) logic for transcript conversion, Claude CLI lifecycle, billing checks, relay validation, and response streaming.

## Architecture

```mermaid
flowchart TB
    subgraph Host[Host machine]
        Pi[Pi runtime]
        Tools[Host tools and projects]
        Provider[pi-claude-cage provider]
        Cage[cage run process]
        Pi <-->|tool calls and results| Tools
        Pi <-->|assistant events| Provider
        Provider <-->|bounded NDJSON over one stdio connection| Cage
    end

    subgraph Guest[Cage Linux VM]
        Service[service.mjs --stdio]
        Adapter[Pinned pi-claude-code]
        Claude[Official Claude Code CLI]
        Relay[Loopback model relay]
        Service --> Adapter --> Claude <--> Relay
    end

    Cage <--> Service
    Relay <-->|HTTPS| Anthropic[Anthropic model service]
```

Each Pi runtime lazily owns one long-lived `cage run` process. A Herdr child is a separate Pi runtime and owns a separate process. Operations are sequential within one runtime. The bridge sends the full transcript first, then sends only an append when history remains a known prefix. The upstream adapter still decides whether Claude Code can continue warmly or needs native transcript replay.

Pi executes tool calls on the host and returns tool results on the next turn. Tool output becomes model input; this package does not sandbox host tools. The bridge opens no LAN listener and needs no shared socket, systemd user service, or bridge-specific environment file.

## Install and configure

Requirements:

- Host Pi 1.6.0 or later.
- Host Node.js 22.19 or later and a POSIX environment with `tar`.
- An initialized, already-running Cage Linux VM.
- Guest Node.js 22.19 or later, npm, Git, and official Claude Code.

Install the standalone package:

```sh
pi install npm:@maxiaochao/pi-claude-cage
```

For local development, run `pi install "$PWD/packages/claude-cage"` from the repository root. Remove a previous local or npm source first so the provider is not loaded twice.

Create `~/.pi/agent/claude-cage.json`, or the equivalent file in your custom Pi agent directory. All paths must be absolute. The first two paths are on the host. `servicePath` is inside the guest.

```json
{
  "executable": "/home/alex/.local/opt/claude-cage-wired/0.2.0-wired.1/cage",
  "config": "/home/alex/.claude-cage-wired/config.json",
  "servicePath": "/home/guest/.local/share/pi-claude-cage/service.mjs"
}
```

Check the expected guest path without making a model request:

```sh
CLAUDE_CAGE_CONFIG=/absolute/path/to/config.json \
  /absolute/path/to/cage run --workdir /tmp -- \
  sh -c 'echo "$HOME/.local/share/pi-claude-cage/service.mjs"'
```

Profiles that still contain `clientPath` are rejected with a migration error. Replace it with `servicePath`, run `/reload`, then run setup.

In Pi:

```text
/reload
/claude-cage-setup
/claude-cage-status
/claude-cage-status models
/model
```

Setup probes the guest and asks for confirmation before it downloads the pinned adapter and installs the stdio service. It does not log in or run a model. A marked v1 installation is stopped and replaced automatically. Unknown, unmarked, foreign, or symlinked destinations fail closed. Fresh v2 setup does not require systemd.

Pi startup does not install files, inspect login, or discover models. `/claude-cage-status` checks the guest CLI and login. `/claude-cage-status models` explicitly requests the catalog and can contact Claude services. Sign in with official Claude Code inside the guest, not with Pi `/login`.

## Runtime and failure behavior

- The fixed maximum model turn is 20 minutes. A caller can request a shorter timeout.
- One logical frame or reconstructed transcript can be at most 256 MiB.
- Writes are sliced and honor stdio backpressure. Thinking output is transferred as deltas rather than repeated cumulative snapshots.
- Clean provider errors, billing rejection, clean cancellation, and confirmed timeout cleanup leave the runtime usable.
- A malformed protocol, transcript hash mismatch, unexpected process loss, or uncertain outcome closes the connection. Pi shows a red error beginning `Claude Cage connection failed and is closed.` Run `/reload` before using the provider again. The bridge does not reconnect or replay an uncertain request.

The service uses the guest user's Claude login and egress. It does not copy credentials from the host, switch accounts, or select account-specific routes. A disconnected request might already be billed. The bridge does not retry it through another account or provider.

## Update and removal

Update the host package, reload Pi, and deploy the matching guest service:

```sh
pi update npm:@maxiaochao/pi-claude-cage
```

Then run `/reload` and confirmed `/claude-cage-setup` while no Cage turn is active. The host update alone does not modify guest files. Protocol mismatches fail instead of falling back.

The installer pins an exact `pi-claude-code` Git revision. The installed revision is recorded in `~/.local/share/pi-claude-cage/upstream/REVISION` inside the VM. The official Claude Code CLI is separate; this package does not install or update it.

The stdio service exits when its owning Pi runtime closes or reloads. There is no v2 daemon to stop. To remove the guest files, first close all Pi and Herdr runtimes that use the profile, then remove `~/.local/share/pi-claude-cage` inside the VM.

See [guest setup and protocol details](guest/SETUP.md) and [acceptance checks](TESTING.md).

![Tool result delivered to host Pi](docs/screenshot.png)

![Status, tool request and result (simulated model, real bridge)](docs/demo.gif)
