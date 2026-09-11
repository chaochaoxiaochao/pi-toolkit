# pi-toolkit

Personal Pi toolkit with the `/todos`, `/btw`, and `/cache_export` extensions, bundled agent skills including Chrome/Chromium automation, the Night Owl theme, and the `pi-worktree` CLI.

## Install

Install the root package to enable the toolkit extensions globally:

```bash
pi install npm:@maxiaochao/pi-toolkit
```

The package also provides the `/btw` side-chat extension, the `web-browser` and `chrome-cdp` skills for Chrome/Chromium CDP automation, and the `nightowl` theme. On npm installation, the postinstall hook selects `nightowl` only when no theme has been configured yet; an existing Pi theme setting is preserved.

The package postinstall hook synchronizes the bundled global instructions to:

```text
~/.pi/agent/AGENTS.md
```

It also selects `nightowl` as the default theme only when `~/.pi/agent/settings.json` does not already contain a theme. To switch manually, use `/settings` or:

```bash
pi --use-theme nightowl
```

An installed package can expose a theme through `pi.themes`, but Pi has no package-manifest field for a default theme, so the guarded postinstall step is used for the npm install case.

When `global/AGENTS.md` changes, publish a new `@maxiaochao/pi-toolkit` version and update installed copies:

```bash
pi update npm:@maxiaochao/pi-toolkit
```

To synchronize the file directly from a checkout instead:

```bash
bash scripts/install.sh
```

The `/btw` side chat is a separate agent session. It can inspect the main conversation and repository, and its thread stays out of the main context until you close it and choose to inject a summary. Use `/btw` to open it or `/btw <question>` to ask directly. While the BTW overlay has focus, use `Up` / `Down` to scroll its transcript one line at a time and `PageUp` / `PageDown` to move by one transcript page.

Use `/cache_export [path]` to write an interactive per-request cache dashboard. It defaults to the latest Context segment for current-state diagnosis, and the View selector can show any earlier segment or all session history. Compaction and model changes both break context charts into segments; cache-hit accumulation also resets at model changes, while TTL and other inferred interruptions remain diagnostic events rather than segment boundaries.

The bundled `nightowl` theme is available to Pi through the package manifest and is selected automatically on npm installation only when no theme is already configured.

## pi-worktree CLI

The package also ships a standalone shell command, `pi-worktree`, that wraps Git worktree creation and Pi launch into one step. On installation (Unix-like systems) the postinstall hook copies it to `~/.local/bin/pi-worktree` and installs bash completion to `~/.local/share/bash-completion/completions/pi-worktree` (no `.bashrc` edits needed).

```bash
pi-worktree start feat-ui  # create/reuse .worktrees/feat-ui, branch feat-ui, launch pi inside
pi-worktree list           # list worktrees (main checkout marked "main checkout")
pi-worktree info feat-ui   # base commit, ahead/behind main, unique commits
pi-worktree out            # open a shell in the main checkout (for merging)
pi-worktree remove feat-ui # remove the worktree (refuses unmerged branches)
pi-worktree prune          # drop stale registrations for manually deleted dirs
```

Typical loop: `pi-worktree start <name>` to start (Tab completes existing worktree names), commit inside Pi, `pi-worktree out` + `git merge <name>` to land the work, `pi-worktree remove <name>` to clean up. New branches are created from the branch you're currently on (or `HEAD` when detached), and the base commit is recorded in `branch.<name>.base` config so `info` can always tell you where the branch came from. Bash completion covers subcommands and existing worktree names (`pi-worktree feat<Tab>`).

The bundled `web-browser` skill provides reusable scripts for starting Chrome/Chromium with remote debugging, navigating tabs, evaluating JavaScript, emulating devices, taking screenshots, dismissing cookie dialogs, and inspecting browser logs. It auto-detects common Chrome/Chromium installations on macOS and Linux, including Windows Chrome when Pi runs under WSL; set `BROWSER_BIN` when the binary is elsewhere.

The browser skill can be loaded explicitly with `/skill:web-browser`. Its scripts are available relative to the skill directory, for example:

```bash
node skills/web-browser/scripts/start.js --headless
node skills/web-browser/scripts/nav.js https://example.com
```

The bundled `chrome-cdp` skill (derived from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill), MIT) complements `web-browser`: instead of launching an isolated browser, it attaches to a Chrome session that already runs with remote debugging (port pre-allocated at launch, or the `chrome://inspect/#remote-debugging` toggle). It is a zero-dependency CLI (`scripts/cdp.mjs`, Node 22+) with per-tab daemons so Chrome's "Allow debugging" modal fires once:

```bash
export CDP_PORT_FILE="/mnt/c/Users/<you>/AppData/Local/Google/Chrome/CDP-Profile/DevToolsActivePort"
node skills/chrome-cdp/scripts/cdp.mjs list          # list open tabs → target prefix
node skills/chrome-cdp/scripts/cdp.mjs snap <target> # accessibility tree
node skills/chrome-cdp/scripts/cdp.mjs eval <target> 'document.title'
```

Note: Chrome does not always write the `DevToolsActivePort` file (e.g. `--remote-debugging-port` launches on Chrome 152); in that case synthesize one from `GET http://127.0.0.1:<port>/json/version` — first line the port, second line the path of `webSocketDebuggerUrl`. WSL auto-discovery of Windows Chrome profiles is not built in; set `CDP_PORT_FILE` as above.

## Tiny Subagent

The tiny subagent is a separate npm package. Install it independently when you want the `tiny_subagents` tool:

```bash
pi install npm:@maxiaochao/pi-tiny-subagent
```

It is not included in the root package's `pi.extensions` list. The two packages have independent versions, release tags, and update commands:

```bash
pi update npm:@maxiaochao/pi-toolkit
pi update npm:@maxiaochao/pi-tiny-subagent
```

See [packages/tiny-subagent/README.md](packages/tiny-subagent/README.md) for personas, model selection, child isolation, live transcript rendering, and diagnostics.

## Codex Edit

The Codex edit package is a separate npm package. Install it when you want GPT/Codex models to use the freeform `apply_patch` protocol while other models keep Pi's native `edit` tool:

```bash
pi install npm:@maxiaochao/pi-codex-edit
```

It includes the extension implementation plus the benchmark summary and interactive architecture explainer. Its versions, release workflow, and tag are independent from the root package and tiny subagent:

```bash
pi update npm:@maxiaochao/pi-codex-edit
```

See [packages/codex-edit/README.md](packages/codex-edit/README.md) for the routing rules and [packages/codex-edit/summary.md](packages/codex-edit/summary.md) for the measured tradeoffs.

## Development

Repository development and release rules are documented in [AGENTS.md](AGENTS.md).
