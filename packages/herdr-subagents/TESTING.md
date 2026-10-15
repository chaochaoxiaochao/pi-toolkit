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
- required explicit Personas in the tool schema and execution, including legacy single-task argument normalization;
- rejection of missing, blank, invalid, and unknown Personas before creating runs, while custom Personas remain supported;
- explicit rejection of parallel write-capable tasks with the conflicting task, Persona, and corrective action;
- waiting through a delayed authoritative report after a prompt transport error while the Pi process is alive;
- explicit failure when the process exits without a report;
- parent cancellation of running and queued tasks;
- startup isolation: a new Pi session neither mutates historical records nor closes their recorded Herdr tabs;
- omitted exposure delegates both tools to Pi's default, while project configuration can consistently select model-only exposure;
- immutable terminal task records;
- idempotent duplicate reports and rejection of conflicting replacements;
- keeping a settled child alive for focus-aware cleanup instead of force-exiting its TUI;
- preserving the configured smoke model, thinking level, and authentication extensions while isolating unrelated settings;
- project-over-global smoke configuration, explicit extension clearing, model overrides, and local-source paths after moving to a temporary directory.

The previous broad lifecycle suite remains available temporarily as `npm run test:legacy --workspace @maxiaochao/pi-herdr-subagents` for migration auditing. Scenarios for background queues, blocked/respond, and historical resume intentionally no longer describe the public contract.

Run extension source loading. The direct-Pi fixture validates explicit file/package sources; Herdr's `builtin:codemode` alias is validated by the real-Herdr smoke because the alias is translated by `herdr agent start`:

```sh
npm run load-test --workspace @maxiaochao/pi-herdr-subagents
```

Run the real Herdr smoke test from a Herdr session:

```sh
npm run test:real-herdr --workspace @maxiaochao/pi-herdr-subagents
```

The smoke reads the effective `analyst` model, thinking level, and explicit `extensions` from the invoking project's normal Herdr configuration (npm's `INIT_CWD`, or the current directory when run directly). It copies only those fields into its temporary configuration. It keeps the bundled read-only Persona, tool allowlist, and test concurrency; user skills, prompts, and unrelated settings are not copied. Local extension paths remain relative to the invoking project. The concurrent package-loading probe appends its test package rather than replacing the configured extensions.

This preserves authentication extensions such as `npm:@maxiaochao/pi-openai-account-pool` in both the single and concurrent cases. Children still use `--no-extensions`: only the mandatory child extensions, configured explicit sources, and test probe load. The smoke does not copy or edit credentials. If no Herdr model is configured, Pi's normal startup model selection still applies.

`HERDR_SUBAGENTS_E2E_MODEL=provider/model` overrides only the smoke model; configured extensions remain loaded. Set `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1` to also verify deferred cleanup while focused and restoration of the original workspace/tab focus.

For real smoke testing, verify that each child appears in a visible pane and can be focused and inspected. An early-finishing child must remain visible while sibling tasks continue. After the whole run settles, a focused child must remain at its restored Pi UI until focus leaves the run tab; the tab must then close automatically. Verify that the parent returns only after all requested tasks settle. Also verify cancellation closes the run tab and does not overwrite a report already atomically published.
