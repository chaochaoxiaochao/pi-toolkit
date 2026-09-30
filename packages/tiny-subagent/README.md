# @maxiaochao/pi-tiny-subagent

A Pi extension that runs one focused subagent synchronously in its own visible Herdr tab. The child has a fresh Pi context; its full answer and session stay in project-local records while the parent receives only a concise summary and document paths.

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

Read-only tasks start FIFO up to the configured concurrency limit. Worker panes are reused as tasks settle, results remain in input order, and one failed task does not cancel its siblings. Any batch containing a write-capable persona is forced to concurrency one.

The call blocks until all children report completion or failure. It creates one unfocused Herdr tab in the current workspace, starts visible Pi tasks in a bounded number of reusable panes, and closes the tab after the run settles. Background execution, recovery, and history UI are not yet provided.

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

The child does not inherit parent extensions, parent conversation, or unconfigured skills, but normal project context files still apply. It uses the same Pi installation, provider configuration, model catalog, and credentials as the parent.
