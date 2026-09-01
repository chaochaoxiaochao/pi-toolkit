# @maxiaochao/pi-tiny-subagent

A small Pi extension that runs one fresh Pi child process for one focused prompt. It does not use the `pi-subagents` package and does not inherit the parent conversation or extensions.

## Install

```bash
pi install npm:@maxiaochao/pi-tiny-subagent
```

The package registers one tool: `tiny_subagents`.

## Personas

The default `agents/worker.md` has this shape:

```md
---
name: worker
description: General-purpose worker for one focused task
tools: read, bash, edit, write, grep, find, ls
---

You are a focused worker subagent.
```

The supported frontmatter fields are:

- `name` (required): Persona name passed in the `agent` field.
- `description` (required): Short description returned by `action: "list"` so the parent model can choose a persona.
- `model` (optional): Default child model, such as `provider/model:high`. A call-level `model` overrides it; if both are absent, the child inherits the current parent-session model.
- `tools` (optional): Comma-separated allowlist of Pi built-in tools. Supported values are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `powershell` on Windows. Extension tools such as `contact_supervisor` are not allowed. If omitted, the child uses Pi's default built-in tools.

For example, a read-only reviewer persona can restrict its tools and select a default model:

```md
---
name: reviewer
description: Review code and report correctness risks without modifying files
model: provider/model:high
tools: read, grep, find, ls
---

Review the assigned code. Do not edit files.
```

Persona files are loaded only from this package's `agents/*.md`; they do not share configuration with `pi-subagents`.

Before execution, the parent model should discover the package-local personas:

```text
tiny_subagents({ action: "list" })
```

It can then match the task to a persona by name or description and execute without `action`:

```text
tiny_subagents({
  agent: "worker",
  prompt: "Inspect the authentication flow and summarize the risks"
})
```

## Execution

The child is started in the current working directory with a fresh context:

```text
pi --mode json --print --no-session --no-extensions --no-skills
```

The selected persona body is passed as an additional system prompt. Only built-in Pi tools can be enabled by `tools` in the persona file.

## Live output

`tiny_subagents` sends a TUI update when the child starts and after each child `message_end` or `tool_result_end` event. While the child is running, the collapsed row shows the latest activity.

Press Pi's `Ctrl+O` tool-output expansion key to inspect the current child execution. The expanded `tiny_subagents` view shows:

- selected persona name and description
- selected model
- the task prompt
- the persona system prompt
- child assistant tool calls, tool results, and assistant text
- the final output and errors

This uses Pi's standard tool-output expansion state, so `Ctrl+O` also changes the expanded/collapsed display state of other tool rows. The added content and event tracking are local to `tiny_subagents`; they do not change other tools or the parent model context.

## Errors and large output

Successful calls return the final assistant text. Failures return the Pi error message, stop reason, exit code, signal, stderr, protocol errors, and output produced before failure. Inline output is limited to 16 KiB. If stdout, stderr, or the final answer exceeds that size, the complete files are retained in a private temporary artifact directory and its path, byte counts, and `cleanup: "remove directory when no longer needed"` instruction are returned. Small-result temporary directories are removed automatically.

The child uses the same Pi installation, provider configuration, model catalog, and authentication environment as the parent process. The package only selects the model; it does not define providers or credentials.
