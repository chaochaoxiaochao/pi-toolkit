# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
4. Verify the README example and the production-runner media `docs/screenshot.png` and `docs/demo.gif` are present in the tarball.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration.
- Run foreground tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Verify all paths use interactive Agent start/prompt without print mode, shell injection, markers, or pane reuse.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects.
- Verify the flat public contract and injectable extension wiring, including Fleet rendering, editor focus ownership, terminal-input passthrough, exact-pane navigation, and stable display while another background run queues.
- Verify parent-shutdown cancellation, cleanup, atomic state replacement, startup retries, and stalled warnings.

## Latest baseline

All 81 deterministic scheduler, recovery, process-boundary, schema-validation, navigation, and persona cases must pass. Release validation also requires extension loading and a real Herdr read-only batch smoke with distinct task panes and final tab cleanup.
