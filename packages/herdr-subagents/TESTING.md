# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. From a dedicated visible X11 Herdr client/window with the GStreamer X11 and VP8 plugins installed, run `HERDR_MEDIA_WINDOW_ID=<window-id> node scripts/capture-package-media.mjs`. Capture intentionally cycles through the live child panes, so avoid using that client/window for other work while recording; the script restores the previously focused pane afterward when it still exists. The Herdr capture must show a parent Pi conversation, a three-task run tab, each of the three real interactive Agent panes receiving focus in turn, the active parent Fleet footer with yellow running indicators and real metrics, and the final compact parent response. The published screenshot must be the parent Fleet view, while the full WebM preserves the parent → three focused children → Fleet → parent sequence.
4. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
5. Verify the README renders the GitHub attachment video directly and live Herdr UI media `docs/screenshot.png` and `docs/demo.webm` are present in the tarball; `docs/demo.gif` must be absent. Inspect the WebM metadata and play it through once to confirm the parent → three focused children → Fleet → parent sequence.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration, including the neutral read-only `analyst` persona.
- Run foreground tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Simulate one fast failure beside a controlled slow success and verify the foreground call returns the stable run ID and failure before releasing the slow task, detaches caller cancellation without aborting that task, releases the dispatcher so the next batch starts before the slow task settles, removes durable queue state, and emits exactly one final follow-up.
- Verify a detached dispatcher promise can settle normally after its successor starts without clearing or otherwise disturbing the successor's active slot, while blocked foreground runs retain their existing dispatcher ownership.
- Let a detached run later block or be explicitly cancelled and verify the newer dispatcher owner remains intact and each detached run emits exactly one final notification.
- Shut down the parent while a handed-off sibling is active and verify it is cancelled and joined, durable queue state is removed, and no stale follow-up is sent.
- Verify all-success foreground batches still wait for every task and explicit `background: true` submissions still return immediately.
- Verify all paths use interactive Agent start/prompt without print mode, shell injection, markers, or pane reuse.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism, including three concurrent `analyst` tasks with independent task-level models.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects, including truncated reports and recovery errors.
- Verify the split public contracts (`herdr_subagents` with required `tasks`, plus `herdr_subagents_control` with required `action`) and injectable extension wiring, including conditional registration only inside Herdr, Fleet rendering, editor focus ownership, terminal-input passthrough, exact-pane navigation, child `/parent` and `Alt+P` return controls, and stable display while another background run queues.
- Verify Fleet divider/row formatting, warning/yellow running indicators, success/green completed indicators, persona and task projections, cumulative active duration across blocking/resume, exact Pi usage aggregation from assistant messages, tool results, standalone usage, compaction, and branch summaries, malformed/truncated JSONL tolerance, queued metric omission, and visible-column bounds at narrow widths.
- Verify live token updates are file-event driven and polled on each running one-second tick, elapsed repainting exists only while work runs, and widget disposal closes watchers and timers.
- Verify selected active/queued run cancellation, blocked-response live Fleet updates, authoritative stale-field replacement, parent-shutdown cancellation, idempotent missing-tab cleanup, cleanup notifications, atomic state replacement, non-retried uncertain startup operations, and stalled warnings.
- Verify `status(runId)` isolates one run, projects queue-only state, prefers durable state over a stale queue record, exposes blocked questions, marks terminal states settled, rejects unknown IDs, and leaves full `history` semantics unchanged.
- Verify resumed batches retain newly allocated pane IDs and historical follow-ups exclude simultaneous session writers.
- Simulate a false screen-settled return while the authoritative Pi lifecycle remains working, then write the report later and verify the task completes without a transient failed state.
- Verify reports are bound to unique attempt IDs, blocked results are not tool errors, duplicate blocked responses are serialized, mixed failed/cancelled aggregates remain partial, and cleanup failures never overwrite business outcomes.

## Latest baseline

All 194 deterministic scheduler, recovery, process-boundary, schema-validation, navigation, metrics, responsive-formatting, lifecycle, attempt-isolation, and persona cases plus the extension-contract lifecycle simulations must pass. Release validation also requires extension loading and a real Herdr read-only batch smoke with distinct task panes and final tab cleanup. The latest smoke completed a read-only package inspection with matching durable attempt/report IDs and automatic tab cleanup.
