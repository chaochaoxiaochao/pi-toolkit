# pi-toolkit

Personal Pi distribution that bundles focused extensions, agent skills, the Night Owl theme, global instructions, and the `pi-worktree` CLI.

## Install

Install the complete toolkit:

```bash
pi install npm:@maxiaochao/pi-toolkit
```

Update it:

```bash
pi update npm:@maxiaochao/pi-toolkit
```

The root package embeds its enabled child-package source snapshots. Todo is intentionally excluded from the default toolkit and remains available as an opt-in standalone package.

Existing toolkit users can pick up the change with:

```bash
pi update npm:@maxiaochao/pi-toolkit
```

Restart Pi after updating. The `todo` tool and widget will no longer load. `pi update --extensions` has the same effect when updating all installed packages. Explicitly versioned sources remain pinned and must be changed or reinstalled without the old version suffix.

## Child packages

| Package | Capability | Install | Update |
|---|---|---|---|
| [pi-todo](packages/todo/README.md) | Optional branch-local execution plan UI; not bundled with pi-toolkit | `pi install npm:@maxiaochao/pi-todo` | `pi update npm:@maxiaochao/pi-todo` |
| [pi-cache-export](packages/cache-export/README.md) | Tau-aligned interactive cache dashboard for Pi sessions | `pi install npm:@maxiaochao/pi-cache-export` | `pi update npm:@maxiaochao/pi-cache-export` |
| [pi-codex-edit](packages/codex-edit/README.md) | Codex-harness `apply_patch` routing for selected GPT models | `pi install npm:@maxiaochao/pi-codex-edit` | `pi update npm:@maxiaochao/pi-codex-edit` |
| [pi-herdr-subagents](packages/herdr-subagents/README.md) | Interactive Herdr Pi Agents with bounded concurrency, direct navigation, and recovery | `pi install npm:@maxiaochao/pi-herdr-subagents` | `pi update npm:@maxiaochao/pi-herdr-subagents` |
| [pi-scheduler](packages/scheduler/README.md) | Session-scoped interval prompts with Agent and `/schedule` controls | `pi install npm:@maxiaochao/pi-scheduler` | `pi update npm:@maxiaochao/pi-scheduler` |
| [pi-worktree](packages/worktree/README.md) | Worktree CLI, current-session switching Extension, and agent skill | `pi install npm:@maxiaochao/pi-worktree` | `pi update npm:@maxiaochao/pi-worktree` |

Each child README owns its feature description, motivation or upstream alignment, examples, screenshots/demos, configuration, and test documentation.

Multiple standalone children may be installed together. `pi-todo` may also be installed alongside the complete toolkit because Todo is no longer bundled. Do not install another bundled child alongside the complete toolkit because that exposes the same resource twice.

To keep Todo after updating the toolkit:

```bash
pi install npm:@maxiaochao/pi-todo
```

If Todo was already installed separately and should be removed completely:

```bash
pi remove npm:@maxiaochao/pi-todo
```

Use `--local` with install or remove when the package declaration belongs to a project's `.pi/settings.json` rather than personal settings.

Root and child versions remain independent, but repository release tooling publishes a modified child and a new toolkit snapshot from the same commit. Run `pi update --extensions` to update all installed packages. Explicit version sources such as `npm:@maxiaochao/pi-toolkit@0.9.3` remain pinned.

## Toolkit-only features

### `/btw`

`/btw` opens a separate side-chat session that can inspect the main conversation and repository without entering the main context. Closing it can optionally inject a summary. Use `Up` / `Down` for line scrolling and `PageUp` / `PageDown` for page scrolling.

### Global instructions and theme

The postinstall hook:

- synchronizes `global/AGENTS.md` to `~/.pi/agent/AGENTS.md`;
- selects `nightowl` only when no theme is configured;
- installs the bundled worktree CLI and bash completion.

Existing theme choices are preserved. To sync only the global instructions from a checkout:

```bash
bash scripts/install.sh
```

## Bundled skills

| Skill | Purpose |
|---|---|
| `web-browser` | Launch and automate an isolated Chrome/Chromium session through CDP |
| `chrome-cdp` | Attach to an existing Chrome debugging session |
| `show-me` | Explain the current topic with the smallest useful visual |
| `html-artifact` | Build self-contained HTML explainers and diagrams |
| `pdlog` | Decompress and inspect Pudu `.pdlog` files |
| `herdr` | Control Herdr workspaces, tabs, panes, and agents |
| `agent-team` | Run tool-agnostic, cross-vendor adversarial review with independent concurrent agents |
| `tapd` | Use the TAPD CLI for requirements, defects, tasks, and wikis |

Package-specific skills, such as `pi-worktree`, are documented by their child package.

## Repository

This repository is an npm workspace. Child implementations live under `packages/*`; `extensions/` contains only the toolkit-only BTW module. Development, testing, media generation, and release rules are documented in [AGENTS.md](AGENTS.md).
