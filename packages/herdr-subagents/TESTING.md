# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. From a visible X11 Herdr client with the GStreamer X11 and VP8 plugins installed, run `HERDR_MEDIA_WINDOW_ID=<window-id> node scripts/capture-package-media.mjs`. The Herdr capture must show a parent Pi conversation, a three-task run tab, each of the three real interactive Agent panes receiving focus in turn, and the final compact parent response.
4. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
5. Verify the README renders the GitHub attachment video directly and live Herdr UI media `docs/screenshot.png` and `docs/demo.webm` are present in the tarball; `docs/demo.gif` must be absent. Inspect the WebM metadata and play it through once to confirm the parent → three focused children → parent sequence.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration.
- Run foreground tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Verify all paths use interactive Agent start/prompt without print mode, shell injection, markers, or pane reuse.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects, including truncated reports and recovery errors.
- Verify the split public contracts (`herdr_subagents` with required `tasks`, plus `herdr_subagents_control` with required `action`) and injectable extension wiring, including conditional registration only inside Herdr, Fleet rendering, editor focus ownership, terminal-input passthrough, exact-pane navigation, and stable display while another background run queues.
- Verify Fleet divider/row formatting, persona and task projections, cumulative active duration across blocking/resume, exact Pi usage aggregation from assistant messages, tool results, standalone usage, compaction, and branch summaries, malformed/truncated JSONL tolerance, queued metric omission, and visible-column bounds at narrow widths.
- Verify live token updates are file-event driven, elapsed repainting exists only while work runs, and widget disposal closes watchers and timers.
- Verify blocked-response live Fleet updates, authoritative stale-field replacement, parent-shutdown cancellation, cleanup notifications, atomic state replacement, non-retried uncertain startup operations, and stalled warnings.
- Verify resumed batches retain newly allocated pane IDs and historical follow-ups exclude simultaneous session writers.

## Latest baseline

All 159 deterministic scheduler, recovery, process-boundary, schema-validation, navigation, metrics, responsive-formatting, and persona cases must pass. Release validation also requires extension loading and a real Herdr read-only batch smoke with distinct task panes and final tab cleanup. The latest smoke completed two concurrent tasks, retained its focused run tab through settlement, and closed it automatically after focus moved away.
