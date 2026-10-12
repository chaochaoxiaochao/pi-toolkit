# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. From a Pi session inside Herdr, run `npm --prefix packages/herdr-subagents run test:real-herdr`. This is a mandatory child-package and root-bundle release gate. It starts one real child Pi and then two concurrent read-only child Pi Agents, requires assistant events and matching attempt-scoped reports, and verifies final tab cleanup. `HERDR_SUBAGENTS_E2E_MODEL=provider/model` optionally pins the smoke model. Failed cleanup preserves the temporary durable records and fails the gate.
4. From a dedicated visible X11 Herdr client/window with the GStreamer X11 and VP8 plugins installed, run `HERDR_MEDIA_WINDOW_ID=<window-id> node scripts/capture-package-media.mjs`. Capture intentionally cycles through the live child panes, so avoid using that client/window for other work while recording; the script restores the previously focused pane afterward when it still exists. The Herdr capture must show a parent Pi conversation, a three-task run tab, each of the three real interactive Agent panes receiving focus in turn, the active parent Fleet footer with yellow running indicators and real metrics, and the final compact parent response. The published screenshot must be the parent Fleet view, while the full WebM preserves the parent → three focused children → Fleet → parent sequence.
5. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
6. Verify the README renders the GitHub attachment video directly and live Herdr UI media `docs/screenshot.png` and `docs/demo.webm` are present in the tarball; `docs/demo.gif` must be absent. Inspect the WebM metadata and play it through once to confirm the parent → three focused children → Fleet → parent sequence.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration, including the neutral read-only `analyst` persona.
- Run foreground tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Simulate one fast failure beside a controlled slow success and verify the foreground call returns the stable run ID and failure before releasing the slow task, detaches caller cancellation without aborting that task, releases the dispatcher so the next batch starts before the slow task settles, removes durable queue state, and emits exactly one final follow-up.
- Verify a detached dispatcher promise can settle normally after its successor starts without clearing or otherwise disturbing the successor's active slot, while blocked foreground runs retain their existing dispatcher ownership.
- Let a detached run later block or be explicitly cancelled and verify the newer dispatcher owner remains intact and each detached run emits exactly one final notification.
- Shut down the parent while a handed-off sibling is active and verify it is cancelled and joined, durable queue state is removed, and no stale follow-up is sent.
- Verify all-success foreground batches still wait for every task and explicit `background: true` submissions still return immediately.
- Verify a blocked dispatcher owner immediately rejects both newly submitted and already-queued foreground runs with its full run ID, keeps explicit background runs queued, and removes queued foreground runs when their caller cancels.
- Verify a parallel task blocks exactly like a serial one, keeping its question, attempt-scoped report, and tab while an independent sibling completes, that answering it settles and closes the run, and that reconciliation treats a blocked report identically at any concurrency.
- Verify two lanes of one parallel batch can block at once, that each question is exposed in turn as they are answered, and that the run closes only after the last answer.
- Answer a blocked lane while a sibling of the same parallel batch is still running and verify the batch keeps sole ownership of its queued tasks, runs them exactly once, and then settles and closes its tab against the task records rather than its own stale blocked snapshot, carrying no lifecycle field the blocked record left behind.
- Verify historical follow-ups cannot create unowned blocked work and owner-loss reconciliation cancels serial blocked work instead of reconstructing hidden dispatcher ownership.
- Verify all paths use interactive Agent start/prompt without print mode, shell injection, markers, or pane reuse.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism, including three concurrent `analyst` tasks with independent task-level models.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects, including truncated reports and recovery errors.
- Verify the split public contracts (`herdr_subagents` with required `tasks`, plus `herdr_subagents_control` with required `action`) and injectable extension wiring, including conditional registration only inside Herdr, Fleet rendering, editor focus ownership, terminal-input passthrough, exact-pane navigation, child `/parent` and `Alt+P` return controls, and stable display while another background run queues.
- Verify Fleet divider/row formatting, warning/yellow running indicators, success/green completed indicators, persona and task projections, cumulative active duration across blocking/resume, exact Pi usage aggregation from assistant messages, tool results, standalone usage, compaction, and branch summaries, malformed/truncated JSONL tolerance, queued metric omission, and visible-column bounds at narrow widths.
- Verify live token updates are file-event driven and polled on each running one-second tick, elapsed repainting exists only while work runs, and widget disposal closes watchers and timers.
- Verify selected active/queued run cancellation, blocked-response live Fleet updates, authoritative stale-field replacement, parent-shutdown cancellation, idempotent missing-tab cleanup, cleanup notifications, atomic state replacement, non-retried uncertain startup operations, and stalled warnings.
- Verify `status(runId)` isolates one run, projects queue-only state, prefers durable state over a stale queue record, exposes blocked questions, marks terminal states settled, rejects unknown IDs, and leaves full `history` semantics unchanged.
- Verify historical follow-ups allow different tasks to share one resume tab while preserving one session writer per task, and active resume membership keeps aggregate status running before the sibling task record is persisted.
- Verify Herdr `blocked` projects only `waiting_interaction`, prompt-delivery timeout projects `delivery_unknown` and accepts a late report, terminal API/process errors without reports fail, and `retrying` remains a display-only running runtime state until a reliable lifecycle source exists.
- Simulate a false screen-settled return while the authoritative Pi lifecycle remains working, then write the report later and verify the task completes without a transient failed state.
- Verify reports are bound to unique attempt IDs, blocked results are not tool errors, duplicate blocked responses are serialized, mixed failed/cancelled aggregates remain partial, and cleanup failures never overwrite business outcomes.
- Verify settling a batch merges run state written concurrently under the run lock instead of overwriting `run.json` from a stale in-memory copy.
- Verify an explicitly named failed task continues from its saved Pi session: it reuses its own live pane while its batch still runs, restarts in a new pane when that pane is gone, refuses to continue without a saved session, is never selected by an unqualified response, and does not start queued siblings that the running batch still owns.
- Verify a settling batch adopts the task records on disk, so a continued task keeps its run `running` and its Herdr tab open instead of being overwritten by the batch's own stale view.
- Verify a continuation claims its task before touching any pane, so a sibling continuation that finishes first leaves the shared tab open, and only the last one to settle closes it.
- Verify a sibling that is still queued is reported as running work rather than as an invented input request with no question.
- Verify a continued task may ask for input, becomes an ordinary blocked task, and is then answerable without naming its number.
- Verify `respond` refuses completed, cancelled, queued, running, and nonexistent tasks without touching Herdr or the run record.

## Latest baseline

All 246 deterministic scheduler, recovery, process-boundary, schema-validation, navigation, metrics, responsive-formatting, lifecycle, attempt-isolation, and persona cases plus the extension-contract lifecycle simulations must pass. The startup regression test reproduces the real ordering where `before_agent_start` records the attempt as working while Herdr can still report stale idle. Every release also runs the real single-Agent and concurrent read-only Herdr smoke; a skipped smoke is not a passing release check.
