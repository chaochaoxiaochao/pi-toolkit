# Testing Herdr Subagents

Run the core suite:

```sh
npm test --workspace @maxiaochao/pi-herdr-subagents
```

It verifies:

- strict serial start order at concurrency one;
- bounded read-only parallelism;
- ordered results despite concurrent completion;
- sibling continuation after failure and all-failed aggregation;
- explicit rejection of parallel write-capable tasks;
- waiting through a delayed authoritative report after a prompt transport error while the Pi process is alive;
- explicit failure when the process exits without a report;
- parent cancellation of running and queued tasks;
- startup isolation: a new Pi session neither mutates historical records nor closes their recorded Herdr tabs;
- immutable terminal task records;
- idempotent duplicate reports and rejection of conflicting replacements;
- keeping a settled child alive for focus-aware cleanup instead of force-exiting its TUI.

The previous broad lifecycle suite remains available temporarily as `npm run test:legacy --workspace @maxiaochao/pi-herdr-subagents` for migration auditing. Scenarios for background queues, blocked/respond, and historical resume intentionally no longer describe the public contract.

Run extension source loading. The direct-Pi fixture validates explicit file/package sources; Herdr's `builtin:codemode` alias is validated by the real-Herdr smoke because the alias is translated by `herdr agent start`:

```sh
npm run load-test --workspace @maxiaochao/pi-herdr-subagents
```

Run the real Herdr smoke test from a Herdr session:

```sh
npm run test:real-herdr --workspace @maxiaochao/pi-herdr-subagents
```

For real smoke testing, verify that each child appears in a visible pane and can be focused and inspected. An early-finishing child must remain visible while sibling tasks continue. After the whole run settles, a focused child must remain at its restored Pi UI until focus leaves the run tab; the tab must then close automatically. Verify that the parent returns only after all requested tasks settle. Also verify cancellation closes the run tab and does not overwrite a report already atomically published.
