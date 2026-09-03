# pi-toolkit

Personal Pi toolkit with the `/todos`, `/btw`, and `/cache_export` extensions, bundled agent skills including Chrome/Chromium automation, and the Night Owl theme.

## Install

Install the root package to enable the toolkit extensions globally:

```bash
pi install npm:@maxiaochao/pi-toolkit
```

The package also provides the `/btw` side-chat extension, the `web-browser` skill for Chrome/Chromium CDP automation, and the `nightowl` theme. On npm installation, the postinstall hook selects `nightowl` only when no theme has been configured yet; an existing Pi theme setting is preserved.

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

The bundled `nightowl` theme is available to Pi through the package manifest and is selected automatically on npm installation only when no theme is already configured.

The bundled `web-browser` skill provides reusable scripts for starting Chrome/Chromium with remote debugging, navigating tabs, evaluating JavaScript, emulating devices, taking screenshots, dismissing cookie dialogs, and inspecting browser logs. It auto-detects common Chrome/Chromium installations on macOS and Linux, including Windows Chrome when Pi runs under WSL; set `BROWSER_BIN` when the binary is elsewhere.

The browser skill can be loaded explicitly with `/skill:web-browser`. Its scripts are available relative to the skill directory, for example:

```bash
node skills/web-browser/scripts/start.js --headless
node skills/web-browser/scripts/nav.js https://example.com
```

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

## Development

Repository development and release rules are documented in [AGENTS.md](AGENTS.md).
