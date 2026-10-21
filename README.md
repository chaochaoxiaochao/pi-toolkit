# pi-toolkit

Personal Pi distribution that bundles focused extensions, agent skills, the Night Owl theme, global instructions, and the `pi-worktree` CLI.

## Install

Requires Pi **1.3.0 or later**. Install the complete toolkit:

```bash
pi install npm:@maxiaochao/pi-toolkit
```

That one install enables six child packages by default, because their source is embedded in the toolkit tarball: `pi-cache-export`, `pi-codex-edit`, `pi-herdr-subagents`, `pi-scheduler`, `pi-background-tasks`, and `pi-worktree`.

`pi-openai-account-pool` is optional and stays a separate install:

```bash
pi install npm:@maxiaochao/pi-openai-account-pool
```

Update it:

```bash
pi update npm:@maxiaochao/pi-toolkit
```

Restart Pi after updating. `pi update --extensions` has the same effect when updating all installed packages. Explicitly versioned sources remain pinned and must be changed or reinstalled without the old version suffix.

## Child packages

| Package | Capability | Installed by `pi-toolkit` | Install | Update | Why |
|---|---|---|---|---|---|
| [pi-cache-export](packages/cache-export/README.md) | Tau-aligned interactive cache dashboard for Pi sessions | Yes | `pi install npm:@maxiaochao/pi-cache-export` | `pi update npm:@maxiaochao/pi-cache-export` | Because I watched the cache video on @alejandro.ao YouTube, which has a Tau style page for viewing cache |
| [pi-codex-edit](packages/codex-edit/README.md) | Codex-harness `apply_patch` routing for selected GPT models | Yes | `pi install npm:@maxiaochao/pi-codex-edit` | `pi update npm:@maxiaochao/pi-codex-edit` | The core lies in the fact that the Codex model is naturally good at apply_patch, and the model is trained on this during training. However, hash-based in-context patch schemes have high token costs and complexity |
| [pi-herdr-subagents](packages/herdr-subagents/README.md) | Visible Herdr Pi Agents coordinated by a small task state machine | Yes | `pi install npm:@maxiaochao/pi-herdr-subagents` | `pi update npm:@maxiaochao/pi-herdr-subagents` | I wanted simple serial or bounded-parallel dispatch while each task stays a real interactive Pi session in its own Herdr pane, and the main conversation only receives short summaries instead of every child's full transcript |
| [pi-openai-account-pool](packages/openai-account-pool/README.md) | Several ChatGPT Plus/Pro logins behind `openai-codex`, switching accounts on a proven quota limit | No | `pi install npm:@maxiaochao/pi-openai-account-pool` | `pi update npm:@maxiaochao/pi-openai-account-pool` | One `/login openai-codex` credential overwrites the previous one, so hitting the subscription limit meant logging in again by hand mid-task; this keeps the accounts I authorized side by side and continues the same request on the next usable one |
| [pi-background-tasks](packages/background-tasks/README.md) | Background shell jobs, bounded logs, completion notifications and a fixed status widget | Yes | `pi install npm:@maxiaochao/pi-background-tasks` | `pi update npm:@maxiaochao/pi-background-tasks` | Long builds and delayed log checks should keep running while the main agent does other work; these are local processes, not subagents |
| [pi-scheduler](packages/scheduler/README.md) | Session-scoped interval prompts with Agent and `/schedule` controls | Yes | `pi install npm:@maxiaochao/pi-scheduler` | `pi update npm:@maxiaochao/pi-scheduler` | I don't recommend this, it's just that it sends messages to the main session at loop intervals |
| [pi-worktree](packages/worktree/README.md) | Worktree CLI, current-session switching Extension, and agent skill | Yes | `pi install npm:@maxiaochao/pi-worktree` | `pi update npm:@maxiaochao/pi-worktree` | In addition to the basic worktree CLI + skill, what can be achieved is to directly switch to the worktree path in the main conversation to continue the task conversation after communicating the requirements in the main conversation |

Each child README owns its feature description, motivation or upstream alignment, examples, screenshots/demos, configuration, and test documentation.

Herdr Subagents tasks require an explicit `agent` Persona; no default `worker` is selected. Choose `reviewer` for independent reviews of proposals, designs, documents, implementations, or analysis; `explorer` for codebase investigation; `worker` for file-changing work; and `analyst` for charter-defined agent-team roles. See [built-in Personas](packages/herdr-subagents/README.md#built-in-personas) for selection guidance and the distinction between parent-facing descriptions and child instructions. Personas can opt into local extension files or npm/git Pi packages through `extensions`. Set top-level `defaultExtensions` in `~/.pi/agent/herdr-subagents.json` (or project `.pi/herdr-subagents.json`) to share a fallback list; Persona-specific lists take precedence, and `[]` clears inherited sources. This uses native Pi package semantics: package-provided skills, prompt templates, and themes may also load, and `--no-skills` does not exclude explicitly selected package skills. See the [extension-source contract](packages/herdr-subagents/README.md#explicit-extension-sources-and-pi-packages) for precedence, isolation, and examples. The [real Herdr smoke test](packages/herdr-subagents/TESTING.md) preserves the configured analyst model and explicit authentication extensions while isolating unrelated settings.

Multiple standalone children may be installed together. `pi-openai-account-pool` may also be installed alongside the complete toolkit because the toolkit does not embed it. Every other child in the table above, including `pi-background-tasks`, is embedded, so a second install exposes the same resource twice.

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
| `show-me` | Explain the current topic with the smallest useful visual |
| `html-artifact` | Build self-contained HTML explainers and diagrams |
| `pdlog` | Decompress and inspect Pudu `.pdlog` files |
| `herdr` | Control Herdr workspaces, tabs, panes, and agents |
| `agent-team` | Manually invoke `/skill:agent-team` for concurrent analysis with configured models and roles, result collection, and investigation records; hidden from automatic model selection |
| `tapd` | Investigate and operate on TAPD items with workspace, evidence, and safe-download guardrails |

Package-specific skills, such as `pi-worktree`, are documented by their child package.

## Repository

This repository is an npm workspace. Child implementations live under `packages/*`; `extensions/` contains only the toolkit-only BTW module. Development, testing, media generation, and release rules are documented in [AGENTS.md](AGENTS.md).

### Post-release verification

After pushing a release, run from this checkout:

```bash
npm run release:check -- v0.13.1
# Wait up to 15 minutes, polling every 15 seconds:
npm run release:check -- v0.13.1 --timeout 900 --interval 15
```

Omit the tag to use the current root `package.json` version. Requires Node.js, Git, npm, tar, authenticated GitHub CLI (`gh auth login`), and local release tags (`git fetch origin --tags` if needed).

The read-only check verifies remote tag commits, waits for the matching `publish.yml` run to succeed, and checks exact public npm versions and tarball integrity. It compares every packaged file and mode against an isolated snapshot of the release tag, including an optional coordinated child release. It uses the tag rather than uncommitted checkout changes, never installs or publishes, and removes temporary downloads. Failures exit nonzero; only a pending workflow or npm `E404` is retried within the shared timeout (600 seconds by default). Local packing uses `--ignore-scripts`, matching this repository's source-only packages; packages that add generated prepack output will need this check updated.
