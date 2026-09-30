## Unreleased

- Run every initial task, blocked response, recovered task, and historical follow-up as a visible interactive Pi Agent through Herdr Agent start/prompt; remove print mode, pane shell injection, completion markers, and marker polling.
- Give every started task a new on-demand pane, retain completed panes until the batch settles, and then close the whole tab with focus-safe cleanup.
- Add a flat fully described tool schema with runtime mode validation and a Fleet-style task list with direct keyboard pane navigation.
- Continue historical sessions as durable turns of the same logical task, and cancel/archive unfinished work when the parent Pi session closes.
- Persist and reconcile queued/running work across parent shutdown, retry only pre-prompt startup, preserve post-submit failures, warn without timing out stalled children, and atomically replace state snapshots.
- Add compact project-local history, saved-session follow-ups in new Herdr tabs, explicit per-run cleanup, unlimited retention, and generated-state Git exclusion.
- Support structured `needs-input` reports, preserve blocked panes and sessions, and resume the original child with `action: respond`.
- Queue background batches behind one active run, return stable IDs immediately, keep progress visible, and send one compact run-level parent notification.
- Show active run counts in a persistent widget, expose compact `/herdr-subagents active` and pane focus navigation, update progress labels, and defer cleanup while a completed tab is focused.
- Execute ordered read-only batches with FIFO bounded concurrency, stable result order, and sibling failure isolation; force write-capable runs to serial execution.
- Add built-in worker, explorer, and reviewer personas with project/global/package discovery precedence.
- Add merged global and project model, thinking, skill, and concurrency settings plus `/herdr-subagents` discovery commands.
- Run one synchronous subagent in a dedicated, unfocused Herdr tab and close it after completion.
- Require a structured child report and return only its summary and document paths to the parent.
- Persist run/task metadata, the full result, and the child Pi session under `.pi/herdr-subagents/runs`.

## 2026-09-30 - v0.1.1

- Add standalone testing documentation and production-runner screenshot/demo media.
- Align the package manifest and root bundle with the shared workspace source.

## 2026-09-01 - v0.1.0

- initial release
