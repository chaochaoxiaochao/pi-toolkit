## Unreleased

- Execute ordered read-only batches with FIFO bounded concurrency, reusable Herdr panes, stable result order, and sibling failure isolation; force write-capable runs to serial execution.
- Add built-in worker, explorer, and reviewer personas with project/global/package discovery precedence.
- Add merged global and project model, thinking, skill, and concurrency settings plus `/subagents` discovery commands.
- Run one synchronous subagent in a dedicated, unfocused Herdr tab and close it after completion.
- Require a structured child report and return only its summary and document paths to the parent.
- Persist run/task metadata, the full result, and the child Pi session under `.pi/herdr-subagents/runs`.

## 2026-09-01 - v0.1.0

- initial release

# Changelog

## 0.1.0

- Add the `tiny_subagents` Pi tool for one focused prompt in a fresh child Pi context.
- Add package-local `worker.md` personas with model and built-in tool selection.
- Return structured process, Pi protocol, stderr, stop-reason, exit, signal, and cancellation diagnostics.
- Preserve oversized stdout, stderr, and final assistant output in private temporary artifacts.
- Stream child event activity to the TUI and expose persona, prompt, and transcript details when expanded.
