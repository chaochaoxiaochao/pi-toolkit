# Testing Pi Scheduler

Run from the repository root:

```bash
npm --prefix packages/scheduler test
npm --prefix packages/scheduler run load-test
npm pack ./packages/scheduler --dry-run
```

The deterministic core test uses a fake clock to verify duration parsing, absolute-time cadence, timed triggering, missed-tick coalescing, dropped-follow-up release, single cancellation, and clear-all timer cleanup. The extension test verifies the concise Agent tool schema, `/schedule` subcommand and ID completion, cancellation without an ID for one schedule, explicit IDs for multiple schedules, the `/schedule <prompt>` 20-second shortcut, preserved prompt whitespace, explicit intervals and reserved commands, timed follow-up delivery, message-specific pending acknowledgement, settled-run fallback cleanup, the above-editor multi-line widget, coexistence with the below-editor Herdr Fleet, duplicate suppression, clear, and shutdown timer cleanup.

For a manual TUI check, run Pi with `-e ./packages/scheduler/extensions/scheduler.ts`, create a short schedule, confirm the status line appears, and verify the prompt starts only after the current turn settles.

Regenerate package media with:

```bash
node scripts/capture-package-media.mjs
```
