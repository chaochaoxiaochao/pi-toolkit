# Testing Pi Scheduler

Run from the repository root:

```bash
npm --prefix packages/scheduler test
npm --prefix packages/scheduler run load-test
npm pack ./packages/scheduler --dry-run
```

The deterministic core test uses a fake clock to verify duration parsing, absolute-time cadence, timed triggering, missed-tick coalescing, manual triggering, dropped-follow-up release, and cancellation. The extension test verifies tool/command parity, manual follow-up delivery, message-specific pending acknowledgement, settled-run fallback cleanup, TUI status, duplicate suppression, and shutdown timer cleanup.

For a manual TUI check, run Pi with `-e ./packages/scheduler/extensions/scheduler.ts`, create a short schedule, confirm the status line appears, and verify the prompt starts only after the current turn settles.

Regenerate package media with:

```bash
node scripts/capture-package-media.mjs
```
