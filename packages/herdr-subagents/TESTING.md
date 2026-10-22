# Testing Herdr Subagents

Run the core suite:

```sh
npm test --workspace @maxiaochao/pi-herdr-subagents
```

It verifies:

- global/project `defaultExtensions` replacement, trimming, source attribution, Persona JSON/Markdown precedence, explicit empty-list clearing, invalid-value diagnostics, and per-call reloads;
- concise Persona names/descriptions in model-facing listings and unknown-Persona errors, including empty lists and visible configuration diagnostics;
- resolved defaults in control result metadata, settings output, and child CLI arguments while preserving mandatory extensions;
- strict serial start order at concurrency one;
- bounded read-only parallelism;
- ordered results despite concurrent completion;
- sibling continuation after failure and all-failed aggregation;
- required explicit Personas in the tool schema and execution, including legacy single-task argument normalization;
- model-facing role selection guidance for broad independent review, codebase investigation, file-changing work, and charter-driven agent-team execution;
- effective Persona descriptions in parent listings, corresponding bodies in child system prompts, and unchanged read/write tool boundaries;
- child system prompts require a terminal `subagent_report` when work finishes or cannot be completed, not a normal text reply or a process-exit condition;
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
- clearing the legacy parent shortcut footer hint while preserving other extension status, with `Alt+P` and `/parent` still focusing the exact parent pane;
- adding `apply_patch` to the child CLI allowlist only when the Persona permits `edit`;
- preserving the configured smoke model, thinking level, and authentication extensions while isolating unrelated settings;
- project-over-global smoke configuration, explicit extension clearing, model overrides, and local-source paths after moving to a temporary directory.

The previous broad lifecycle suite remains available temporarily as `npm run test:legacy --workspace @maxiaochao/pi-herdr-subagents` for migration auditing. Scenarios for background queues, blocked/respond, and historical resume intentionally no longer describe the public contract.

Run extension source loading. The direct-Pi fixture resolves global `defaultExtensions` and validates real file/package loading; Herdr's `builtin:codemode` alias is validated by the real-Herdr smoke because the alias is translated by `herdr agent start`:

```sh
npm run load-test --workspace @maxiaochao/pi-herdr-subagents
```

The native CLI fixture also exercises an extension that switches `edit` to `apply_patch`. It checks the final active tools, not just status text: writable children retain the selected patch tool, read-only/no-editor children do not gain it, and children without the patch extension retain native `edit`. This deterministic probe does not call a model or test Codex Edit's parser.

Run the real Herdr smoke test from a Herdr session:

```sh
npm run test:real-herdr --workspace @maxiaochao/pi-herdr-subagents
```

The smoke reads the effective `analyst` model, thinking level, and explicit `extensions` from the invoking project's normal Herdr configuration (npm's `INIT_CWD`, or the current directory when run directly). It copies only those fields into its temporary configuration. It keeps the bundled read-only Persona, tool allowlist, and test concurrency; user skills, prompts, and unrelated settings are not copied. Local extension paths remain relative to the invoking project. The concurrent package-loading probe appends its test package rather than replacing the configured extensions. The isolated smoke supplies these sources through global `defaultExtensions`, so both single and concurrent runs exercise default resolution, actual child loading, durable task records, and tab cleanup.

This preserves authentication extensions such as `npm:@maxiaochao/pi-openai-account-pool` in both the single and concurrent cases. Children still use `--no-extensions`: only the mandatory child extensions, configured explicit sources, and test probe load. The smoke does not copy or edit credentials. If no Herdr model is configured, Pi's normal startup model selection still applies.

`HERDR_SUBAGENTS_E2E_MODEL=provider/model` overrides only the smoke model; configured extensions remain loaded. Set `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1` to also verify deferred cleanup while focused and restoration of the original workspace/tab focus.

For real smoke testing, verify that each child appears in a visible pane and can be focused and inspected. An early-finishing child must remain visible while sibling tasks continue. After the whole run settles, a focused child must remain at its restored Pi UI until focus leaves the run tab; the tab must then close automatically. Verify that the parent returns only after all requested tasks settle. Also verify cancellation closes the run tab and does not overwrite a report already atomically published.
