# @maxiaochao/pi-tiny-subagent

A Pi extension that runs one focused subagent synchronously in its own visible Herdr tab. The child has a fresh Pi context; its full answer and session stay in project-local records while the parent receives only a concise summary and document paths.

## Requirements and install

Run Pi inside Herdr, then install the package:

```bash
pi install npm:@maxiaochao/pi-tiny-subagent
```

The package registers one tool, `tiny_subagents`. Calls outside a Herdr workspace fail without starting a child.

## Usage

Discover the package-local personas first:

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

The call blocks until the child reports completion or failure. It creates an unfocused Herdr tab in the current workspace, starts Pi in that tab, submits the prompt, and closes the tab after the report is received. Batch execution, background execution, recovery, and history UI are not provided.

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

Persona files are loaded only from this package's `agents/*.md`. The child does not inherit parent extensions or skills, but normal project context files still apply. It uses the same Pi installation, provider configuration, model catalog, and credentials as the parent.
