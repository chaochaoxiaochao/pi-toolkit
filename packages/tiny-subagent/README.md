# @maxiaochao/pi-tiny-subagent

A Pi extension that runs focused synchronous or background subagent batches in visible Herdr tabs. Children have fresh Pi contexts; full answers and sessions stay in project-local records while the parent receives only concise summaries and document paths.

## Requirements and install

Run Pi inside Herdr, then install the package:

```bash
pi install npm:@maxiaochao/pi-tiny-subagent
```

The package registers one tool, `tiny_subagents`. Calls outside a Herdr workspace fail without starting a child.

## Usage

Discover the effective personas first:

```text
tiny_subagents({ action: "list" })
```

Then run one self-contained task:

```text
tiny_subagents({
  agent: "worker",
  label: "auth-review",
  prompt: "Inspect the authentication flow and summarize the risks"
})
```

Or submit an ordered synchronous batch:

```text
tiny_subagents({
  label: "security-review",
  concurrency: 3,
  tasks: [
    { name: "auth", agent: "reviewer", prompt: "Review authentication" },
    { name: "sessions", agent: "explorer", prompt: "Trace session storage" }
  ]
})
```

Set `background: true` to return a stable run ID immediately while the queue continues. One run is dispatched at a time by an extension instance; later runs remain queued and start FIFO. Each background run sends one compact parent notification only when the whole run completes, partially fails, fails, or blocks. Individual successful tasks do not wake the parent model.

A child missing required information reports `needs-input` with an exact question. The run becomes blocked, keeps its Herdr tab, pane, partial report, and Pi session, and returns control to the parent. Answer through the same tool to continue the original session:

```text
tiny_subagents({ action: "respond", runId: "<run-id>", answer: "Use the main branch." })
```

`/subagents focus <task-number>` can also open the blocked pane for direct manual interaction.

## History

Run `/subagents history` or `tiny_subagents({ action: "history" })` to list compact project-local run and task reports after Herdr tabs close. Full results, described documents, artifacts, and persistent Pi sessions remain separate on disk and are not loaded into parent context.

Continue a saved conversation in a new Herdr tab with `tiny_subagents({ action: "resume", runId: "<run-id>", task: 1, prompt: "Follow up..." })`. Remove only a selected archive with `tiny_subagents({ action: "cleanup", runId: "<run-id>" })`. History has no automatic count-based eviction. The extension adds the runtime path to local Git excludes when available (and otherwise uses `.pi/.gitignore`) without overwriting unrelated rules.

Read-only tasks start FIFO up to the configured concurrency limit. Worker panes are reused as tasks settle, results remain in input order, and one failed task does not cancel its siblings. Any batch containing a write-capable persona is forced to concurrency one.

While a run is active, the parent widget shows running, queued, blocked, failed, and completed counts. `/subagents active` shows the compact task list, and `/subagents focus <task-number>` jumps to the exact active Herdr pane without copying its transcript into Pi. Tab and pane labels track progress and stable task order. Completed tabs close immediately when unfocused; a tab being inspected waits until focus leaves.

Foreground calls block until all children report completion, failure, or a request for input. Each run creates one unfocused Herdr tab in the current workspace, starts visible Pi tasks in a bounded number of reusable panes, and closes the tab after the run settles unless it is focused or blocked.

## Reports and records

The child must finish through the package's structured `subagent_report` tool. The parent receives only:

- completion or failure status
- a concise summary
- paths to useful documents
- the task-record location

The complete result is not copied into the parent model context. Each run is retained under:

```text
.pi/herdr-subagents/runs/<run>/tasks/<task>/
```

The task directory contains the full result, structured report, task metadata, system prompt, and persistent Pi session. Run-level metadata is stored in the parent run directory.

## Personas

The package includes `worker` (write access), `explorer` (read access), and `reviewer` (read access). Persona definitions are discovered in this order, with the first available higher-precedence definition replacing the lower one:

1. `.pi/subagents/agents/*.md` in the project
2. `~/.pi/agent/subagents/agents/*.md` globally
3. this package's `agents/*.md`

A custom persona without `access` is treated as write-capable. Definitions may set `access`, `model`, `thinking`, `tools`, and `skills` in frontmatter.

The default `agents/worker.md` uses this format:

```md
---
name: worker
description: General-purpose worker for one focused task
tools: read, bash, edit, write, grep, find, ls
---

You are a focused worker subagent.
```

Supported frontmatter:

- `name` and `description` are required.
- `model` optionally selects a child model. A call-level `model` overrides it; otherwise the current session model is inherited.
- `tools` optionally restricts built-in tools. `subagent_report` is always added so the child can settle the task.
- `access` is `read` or `write`; omitted custom values default to `write`.
- `thinking` and `skills` provide persona defaults.

Global settings live at `~/.pi/agent/subagents.json`; project overrides live at `.pi/subagents.json`. Both support `defaultConcurrency`, `maxConcurrency`, `stalledWarningSeconds`, `defaultModel`, and a `personas` object whose entries can override `model`, `thinking`, and `skills`.

```json
{
  "defaultModel": "provider/model",
  "maxConcurrency": 3,
  "personas": {
    "reviewer": { "thinking": "high", "skills": ["code-review"] }
  }
}
```

Project values override global values recursively. Model resolution is: task override, project persona setting, global persona setting, persona frontmatter, global/project default model, then parent model. Run `/subagents agents`, `/subagents models`, or `/subagents settings` to inspect effective values and their sources.

## Recovery and failures

Queued background submissions are persisted before dispatch. Parent shutdown pauses new queued tasks while already-running Herdr children may finish. On the next Pi start, the extension reconciles saved reports and live panes, resumes safe queued dispatch, and marks a vanished child as interrupted.

Tab, pane, and child startup failures are retried at most twice before a prompt is submitted. A failure after submission is preserved and never automatically rerun. `stalledWarningSeconds` emits a warning without killing long-running work. Run/task/report snapshots use atomic replacement so interruption cannot expose half-written JSON.

The child does not inherit parent extensions, parent conversation, or unconfigured skills, but normal project context files still apply. It uses the same Pi installation, provider configuration, model catalog, and credentials as the parent.
