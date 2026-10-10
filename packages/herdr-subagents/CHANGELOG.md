## 2026-10-10 - v0.4.6

- reduce global prompt noise by keeping Subagent workflow guidance in tool descriptions

## 2026-10-10 - v0.4.5

- fix transient retry lifecycle, attempt isolation, and recovery semantics
- prevent transient Herdr states from finalizing live child attempts
- Report authoritative child Pi lifecycle state even under `--no-extensions`, wait through provider retry/fallback until the matching structured report arrives, and bind every report to a unique attempt ID.
- Reconcile matching attempt reports after interruption, serialize blocked responses, keep blocked results non-error, and preserve business outcomes when tab cleanup fails.
- Aggregate mixed failed/cancelled task sets as partial instead of hiding one terminal outcome.

## 2026-10-09 - v0.4.4

- return failed foreground batches early while surviving subagents continue in background
- Return a foreground concurrent batch as soon as one task fails, keep surviving siblings running under durable background ownership, and send exactly one final follow-up after the whole batch settles.
- Release the dispatcher slot at foreground failure handoff so later batches start immediately, while detached work remains cancellable, participates in shutdown, and cannot clear a newer active run when it settles.
- Preserve full-batch waiting for successful foreground runs and the immediate-return behavior of explicit background runs.
- Join every started batch worker before resolving its run promise, including when another worker's final state persistence fails.

## 2026-10-09 - v0.4.3

- add per-run status, neutral analyst persona, and tool-agnostic Agent Team protocol
- Add `herdr_subagents_control({ action: "status", runId })` for a compact snapshot of one queued, active, blocked, or settled run without loading the full history archive.
- Add a neutral read-only `analyst` persona for tasks that assign models and methodological roles dynamically.

## 2026-10-08 - v0.4.2

- add Alt+P and /parent controls to return from child Agents
- Add `/parent` and `Alt+P` inside child Agents to return focus to the exact parent Agent pane, with a visible child footer hint.

## 2026-10-08 - v0.4.1

- targeted cancellation, live token polling, and idempotent tab cleanup
- Add `cancel` control for one active or queued run while leaving unrelated runs untouched.
- Refresh live Fleet token totals every second as well as on file events.
- Treat already-missing tabs as successful cleanup and emit one warning per real cleanup failure.

## 2026-10-08 - v0.4.0

- add the live compact Fleet footer with authoritative metrics and refreshed media
- Replace the below-editor task list with a compact responsive Fleet monitor showing authoritative persona, task status, cumulative active time, and true child Pi usage from assistant, tool-result, standalone usage, compaction, and branch-summary entries.
- Update Fleet metrics from child-session file events, repaint elapsed time only while work runs, safely ignore malformed or partial JSONL tails, and dispose every watcher and timer with the widget.
- Preserve exact-pane keyboard focus while extending blocked-response and historical-resume activity projections with durable timing and session metadata.
- Use warning/yellow indicators for running Fleet rows and success/green indicators for completed rows, compact the shared metrics column instead of pushing it to the terminal edge, and publish media that demonstrates the live parent footer while restoring focus after capture.

## 2026-10-08 - v0.3.0

- split execution and control tools and unify task runs
- Split execution and control into `herdr_subagents` and `herdr_subagents_control`; require a non-empty `tasks` array for new runs so one-item runs and batches share background and concurrency semantics.
- Normalize legacy top-level single-task prompts into one-item task arrays before schema validation.

## 2026-10-08 - v0.2.1

- add default thinking configuration and inline Herdr workflow video
- Add merged global/project `defaultThinking`, below persona-specific thinking and above parent-session fallback, with effective source reporting.
- Embed the workflow video directly in the GitHub README, retain the reproducible WebM source, and remove the GIF preview.
- Expand the README with every settings and persona option, accepted values, defaults, paths, examples, and exact model, thinking, skills, and definition precedence.
- Add a full WebM recording that focuses all three live child Agent panes before returning to the parent summary.
- Replace the rendered transcript media with a real Herdr UI recording that follows a parent Pi conversation through a three-Agent batch and final compact response.

## 2026-10-08 - v0.2.0

- replace Tiny Subagent with visible interactive Herdr agents and durable batch workflows
- Skip tool and command registration outside a Herdr workspace so unavailable Subagent capabilities do not enter the model context.
- Preserve newly allocated panes when blocked runs resume, stop blindly retrying Herdr resource-creating commands after uncertain failures, and prevent concurrent historical resumes from writing the same Pi session.
- Isolate malformed queue/history entries so healthy active runs and durable history remain recoverable, and share durable attempt settlement plus task projection contracts across execution modes.
- Retain blocked Fleet and dispatcher ownership after stateless response errors, and include public test entrypoints in the published package.
- Preserve every pending stale-tab cleanup across repeated pane migrations, retry all of them during startup reconciliation, and surface allocator cleanup failures through batch updates.
- Keep persisted reports authoritative even when Herdr transport fails after submission, persist failure reports for historical follow-ups, reject resume attempts against active or cleanup-pending runs, recover terminal deferred cleanup on startup, preserve cancelled ownership on shutdown, keep recovered Agent attempts aligned with durable turns, archive malformed turns, remove rejected background queue entries, support Pi enhanced keyboard sequences and authoritative status rendering, centralize lifecycle metadata, surface control-plane and cleanup failures, merge deferred cleanup against current durable state, and force-close focused tabs when parent shutdown is already active.
- Share strict report parsing across live and recovered paths, validate durable task ordering, surface unreadable queue/history records, reconcile prior sessions even within one Pi process, keep settled Fleet rows navigable, preserve surviving sibling panes during dead-pane recovery, and retain cleanup diagnostics.
- Keep queued and blocked siblings alive when one blocked response fails, centralize authoritative run-status transitions, and bind focus-deferred tab cleanup to parent-session shutdown.
- Retain dispatcher and Fleet ownership while a batch is blocked, centralize task/turn transitions, surface transient pane lookup failures, and notify deferred single-task cleanup failures.
- Fail reconciliation when task records are unreadable, archive malformed child reports before replacing them with valid failure records, and keep durable history and saved-session follow-up usable.
- Keep startup reconciliation moving past truncated child reports, resume dispatch after recovery errors, clear stale blocked fields after authoritative follow-ups, and surface deferred cleanup failures.
- Stream Fleet row and pane updates while a blocked answer resumes work and releases queued siblings.
- Keep the active Fleet widget stable when another background run is queued, refresh rows and pane navigation after blocked responses, and cover the public extension UI/input wiring with injectable dependencies.
- Centralize parent ownership, run-status aggregation, and serialized pane allocation across initial, continued, recovered, and historical runs.
- Run every initial task, blocked response, recovered task, and historical follow-up as a visible interactive Pi Agent through Herdr Agent start/prompt; remove print mode, pane shell injection, completion markers, and marker polling.
- Give every started task a new on-demand pane, retain completed panes until the batch settles, and then close the whole tab with focus-safe cleanup.
- Add a flat fully described tool schema with runtime mode validation and a Fleet-style task list with direct keyboard pane navigation.
- Continue historical sessions as durable turns of the same logical task, and cancel/archive unfinished work when the parent Pi session closes.
- Persist and reconcile queued/running work across parent shutdown, avoid retrying uncertain startup operations, preserve post-submit failures, warn without timing out stalled children, and atomically replace state snapshots.
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
