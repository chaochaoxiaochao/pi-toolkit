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

The root package embeds the child-package source snapshots listed below. Install the complete toolkit or selected standalone children, not both.

## Child packages

| Package | Capability | Install | Update |
|---|---|---|---|
| [pi-todo](packages/todo/README.md) | Session plans, automatic task advancement, `/todos` | `pi install npm:@maxiaochao/pi-todo` | `pi update npm:@maxiaochao/pi-todo` |
| [pi-cache-export](packages/cache-export/README.md) | Tau-aligned interactive cache dashboard for Pi sessions | `pi install npm:@maxiaochao/pi-cache-export` | `pi update npm:@maxiaochao/pi-cache-export` |
| [pi-codex-edit](packages/codex-edit/README.md) | Codex-harness `apply_patch` routing for selected GPT models | `pi install npm:@maxiaochao/pi-codex-edit` | `pi update npm:@maxiaochao/pi-codex-edit` |
| [pi-tiny-subagent](packages/tiny-subagent/README.md) | One focused task in a fresh child Pi context | `pi install npm:@maxiaochao/pi-tiny-subagent` | `pi update npm:@maxiaochao/pi-tiny-subagent` |
| [pi-worktree](packages/worktree/README.md) | Worktree CLI, completion, installer, and agent skill | `pi install npm:@maxiaochao/pi-worktree` | `pi update npm:@maxiaochao/pi-worktree` |

Each child README owns its feature description, motivation or upstream alignment, examples, screenshots/demos, configuration, and test documentation.

Multiple standalone children may be installed together. Do not install a child alongside the complete toolkit because that exposes the same resource twice.

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
| `agent-team` | Run cross-vendor adversarial review through Herdr |
| `tapd` | Use the TAPD CLI for requirements, defects, tasks, and wikis |
| `calldiff` | Diff call stacks across commits |

Package-specific skills, such as `pi-worktree`, are documented by their child package.

## Repository

This repository is an npm workspace. Child implementations live under `packages/*`; `extensions/` contains only the toolkit-only BTW module. Development, testing, media generation, and release rules are documented in [AGENTS.md](AGENTS.md).
