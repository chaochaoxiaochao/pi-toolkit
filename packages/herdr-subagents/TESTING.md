# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. From a visible X11 Herdr client, run `HERDR_MEDIA_WINDOW_ID=<window-id> node scripts/capture-package-media.mjs`. The Herdr capture must show a parent Pi conversation, a three-task run tab with three real interactive Agent panes, and the final compact parent response.
4. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
5. Verify the README example and live Herdr UI media `docs/screenshot.png` and `docs/demo.gif` are present in the tarball.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration.
- Run foreground tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Verify all paths use interactive Agent start/prompt without print mode, shell injection, markers, or pane reuse.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects, including truncated reports and recovery errors.
- Verify the flat public contract and injectable extension wiring, including conditional registration only inside Herdr, Fleet rendering, editor focus ownership, terminal-input passthrough, exact-pane navigation, and stable display while another background run queues.
- Verify blocked-response live Fleet updates, authoritative stale-field replacement, parent-shutdown cancellation, cleanup notifications, atomic state replacement, non-retried uncertain startup operations, and stalled warnings.
- Verify resumed batches retain newly allocated pane IDs and historical follow-ups exclude simultaneous session writers.

## Latest baseline

All 133 deterministic scheduler, recovery, process-boundary, schema-validation, navigation, and persona cases must pass. Release validation also requires extension loading and a real Herdr read-only batch smoke with distinct task panes and final tab cleanup. The latest smoke completed two concurrent tasks, retained its focused run tab through settlement, and closed it automatically after focus moved away.
