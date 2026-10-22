# Testing Pi Background Tasks

Run from the repository root, with Node 22.19+ and Pi 1.3.0+ on PATH:

```bash
npm --prefix packages/background-tasks test
npm --prefix packages/background-tasks run load-test
npm pack ./packages/background-tasks --dry-run
```

Tests use Node's built-in test runner. They resolve host peers from the installed Pi rather than installing another copy. npm's workspace `node_modules/.bin` directories are excluded from this lookup because they can contain an older development Pi. Set `PI_TEST_BINARY=/absolute/path/to/pi` to choose a specific host.

- `tasks.mjs`: fake execution and clock at the task-manager interface; immediate return, two slots, validation, timeout/cancel races, final failure, disk budgets, write errors, bounded history and shutdown.
- `output.mjs`: compares both output views with the real host Bash tool. Covers line/byte limits, long lines, empty output, missing final newline, UTF-8 split across chunks, invalid UTF-8 and logs larger than 1 MiB.
- `processes.mjs`: the native backend, a multi-line Python log check, non-blocking concurrency, PID-observed process-tree cleanup, silent busy-loop timeout and the default 32 MiB disk limit.
- `extension.mjs`: real extension registration with fake execution/clock; schema errors, command parity, parent-signal independence, merged busy/idle notifications, terminal-output consumption and failed-read retention, abort/error boundaries, manual-compaction-style busy intervals without agent boundaries, other extensions' draft preservation, no output in notifications, above-editor placement, five-second retention, narrow/CJK rendering, coexistence and non-TUI modes. Checks the exact approved startup guidance in both return paths and the tool description; verifies 24-hour retention after an interrupt, output consumption while stopped, custom-wake isolation and restoration of automatic delivery by a new user-message run.
- `notifications.mjs`: isolated real Pi with direct tool batches or its native Codemode tool, default one-at-a-time queues and an offline provider. Four actual failing shell jobs finish while a synchronous tool stands in for a subagent. The next model request gets one merged notification, excluding zero, one or four consumed terminal outputs; no extra requests follow the final report. Also verifies that native Codemode and the next model request receive the exact startup guidance. The blocking tool is a fixture, not a real Herdr child. `BG_TEST_EXTENSION=/absolute/path/to/background-tasks.ts` can run the queue regressions against an older implementation.
- `compaction.mjs`: isolated native Pi SDK sessions call `session.compact()`, the same manual-compaction entry point used by `/compact` and RPC. Real shell jobs exit during a held offline summary request. Covers successful native compaction, a provider summary error and `abortCompaction()` cancellation; each must retain the pending completion while busy and automatically deliver it once afterward, without another user prompt. Checks actual compaction lifecycle/events, saved compaction entries, completion timestamps/logs and exactly one automatic conversation request. Uses real timers and native `isIdle`/`isCompacting`, not injected busy state or replacement compaction results; no paid model call or TUI keyboard invocation of `/compact`. `BG_TEST_EXTENSION` also supports a negative-control extension.
- `interruptions.mjs`: isolated native Pi SDK sessions call the real `session.abort()` while a foreground tool is held. A real shell finishes before or after the interrupt; terminal timestamps verify the ordering. Native `agent_settled.aborted` must confirm the stop; no completion may start another model request. A new user prompt sees the retained completion in its first request, reads the real failed task's output, and finishes without duplicate delivery or extension errors. A third case starts actual manual compaction while the foreground tool is held: Pi itself interrupts the active agent, which must stay stopped even after compaction and background completion. The public abort event has no reason field, so the extension preserves this native interruption rather than guessing its source. `BG_TEST_EXTENSION` supports a negative control without interrupt suppression.

Compaction cancellation assertions use native lifecycle `aborted` flags and the absence of a saved compaction entry, not version-dependent error strings. Agent interruption is a different state and is tested separately.

Notification retry tests use the injected clock and session-idle interface. They check the 1/2/4/8/16/30-second delays, the repeated 30-second cap, retention across 24 hours of busy time, one timer shared by new completions, immediate boundary delivery, fresh-batch reset, and cleanup on terminal reads, abort/error boundaries and session replacement. No compression-event subscription or notification pause action is introduced. Offline fixtures prove guidance delivery, not that a live model always obeys it; no paid/live-model anti-polling evaluation is part of this suite.

Load-test uses an isolated temporary agent directory, the production extension and an offline fixture provider. It does not access real provider credentials or alter the user's installed packages. From the workspace, `npm --prefix packages/background-tasks run load-test -- --toolkit` loads the complete toolkit directory through its manifest and verifies exactly one background-task tool; the root load-test runs this check too.

## Real Pi TUI

Requires Python 3 with the existing `pexpect` module; process fixtures use Bash, Python and `ps`. The current native-process/TUI suite is verified on Linux.

```bash
python3 packages/background-tasks/tests/tui-smoke.py .cache/verification/background-tui
```

This starts a real Pi in a PTY with the production extension, Scheduler, the built-in Codemode tool and a deterministic fixture provider. It checks two jobs, rejection of a third, Codemode completion while jobs remain alive, explicit output, cancellation, automatic main-agent notification, reload/new/quit cleanup and log removal. It observes both persisted boundary entries and idle custom messages by unique session-entry ID, and rejects duplicate notifications. No network model calls occur. Mocked UI tests separately verify the exact five-second boundary.

Results and the actual ANSI stream are stored under the chosen evidence directory. Real screenshots require an isolated X11 terminal window, `gnome-terminal.real`, `xwininfo` and ImageMagick `import`:

```bash
gnome-terminal.real --wait --window --title='Pi Background Tasks Smoke' --geometry=140x42 -- \
  env BG_SMOKE_RENDER=1 BG_SMOKE_CAPTURE=1 python3 \
  "$PWD/packages/background-tasks/tests/tui-smoke.py" "$PWD/.cache/verification/background-tui-live"
```

It relays the real PTY output, captures only the test window, then closes it. Inspect the running, completed and history screenshots; check the widget has disappeared in the last one. Provider decisions are fixtures; tool execution, shell jobs, queues, TUI and cleanup are real.

For the original delayed-check scenario, also run one 60-second sleep + Python heredoc check against temporary build log/exit files. The normal regression uses a one-second delay to keep the suite short.

## Media and workspace checks

```bash
node scripts/capture-package-media.mjs background-tasks
node tests/package-layout.mjs
node tests/release-check.mjs
npm test
npm run load-test
npm pack --dry-run
git diff --check
```

The media command requires the real-TUI screenshot prerequisites above, plus Pillow. It reruns the real TUI and renders PNG/GIF from captured running/completed/history frames, not invented output. Inspect and click both links in `docs/package-media-gallery.html` with Chrome. The root tarball must include `packages/background-tasks/`, and the root default loadout must enable its extension exactly once. The standalone tarball remains independently loadable.

Record actual checks and any missing prerequisites in `docs/verification.md`. A missing GUI, skipped browser check or unavailable Pi does not count as a successful end-to-end verification.
