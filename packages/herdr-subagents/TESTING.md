# Herdr Subagents test strategy

## Flow

1. `npm --prefix packages/herdr-subagents test` runs deterministic scheduler, recovery, and persona tests.
2. `pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts` verifies extension loading.
3. `npm pack ./packages/herdr-subagents --dry-run` verifies package contents.
4. Verify the README example and the production-runner media `docs/screenshot.png` and `docs/demo.gif` are present in the tarball.

## Cases

- Resolve package, global, and project personas and validate frontmatter/configuration.
- Run synchronous tasks and FIFO bounded-concurrency batches through an injectable Herdr boundary.
- Force write-capable batches to serial execution while allowing bounded read-only parallelism.
- Preserve compact reports, full results, Pi sessions, blocked questions, and historical follow-ups.
- Recover queued/running work after interruption without retrying post-prompt side effects.
- Verify widgets, pane navigation, cleanup, atomic state replacement, startup retries, and stalled warnings.

## Latest baseline

All 58 deterministic scheduler, recovery, process-boundary, and persona cases pass. Release validation also requires extension loading and a real Herdr read-only batch smoke.
