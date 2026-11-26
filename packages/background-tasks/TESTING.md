# Testing Pi Background Tasks

Run from the repository root, with Node 22.19+ and Pi 1.3.0+ on PATH:

```bash
npm --prefix packages/background-tasks test
npm --prefix packages/background-tasks run load-test
npm pack ./packages/background-tasks --dry-run
```

Tests use Node's built-in test runner. They resolve host peers from the installed Pi rather than installing another copy. npm's workspace `node_modules/.bin` directories are excluded from this lookup because they can contain an older development Pi. Set `PI_TEST_BINARY=/absolute/path/to/pi` to choose a specific host.

- `tasks.mjs`: fake execution and clock at the task-manager interface; immediate return, two slots, validation, timeout/cancel races, final failure, disk budgets, write errors, bounded history and shutdown.
- `output.mjs`: compares the shared 100-line/8-KiB preview with the real host Bash tool’s output, retaining unchanged small-output display parity and deliberately tighter truncation for large output. Covers line/byte limits, long lines, empty output, missing final newline, UTF-8 split across chunks, invalid UTF-8 and logs larger than 1 MiB. Checks both return paths carry the same tail, omission metadata reports total size, and full captured bytes remain on disk. The former Bash-sized display/1-MiB structured contract is retired; each retained fixture now verifies the bounded replacement.
- `processes.mjs`: the native backend, a multi-line Python log check, non-blocking concurrency, PID-observed process-tree cleanup, silent busy-loop timeout and the default 32 MiB disk limit.
- `extension.mjs`: real extension registration with fake execution/clock; schema errors, local panel inspection parity, parent-signal independence, merged busy/idle notifications, terminal-output consumption and failed-read retention, abort/error boundaries, manual-compaction-style busy intervals without agent boundaries, other extensions' draft preservation, status-only completion text with log paths and progressive-inspection guidance, no automatic stdout/stderr injection or log-file reads, a 16-KiB status/path batch cap, lossless splitting of large metadata batches, explicit timeout/empty-result status, independent missing-log and healthy-sibling manual inspections, synchronous delivery-failure retention, bottom-footer placement beside editor status, complete footer hiding/restoration around the panel, five-second retention, narrow/CJK rendering, coexistence and non-TUI modes. It verifies keyed-status fallback with a pre-existing foreign footer, safe self-detachment when a later footer replaces the decorator, and no running-task repaint timer. Checks one aggregate progress turn after 30 fake minutes, byte deltas without log contents, timer reset by a new parent run, completion precedence, interruption cleanup, the exact three-sentence tool description, the explicit end-turn/no-sleep start reminder, fixed `model-only` exposure, no prompt guidelines, and running-task `list`/`output` availability when inspection is actually needed.
- `panel.mjs`: singular/plural counter, arbitrary peer-status ordering and sanitization, narrow-width priority, mouse hit region, screenshot-style field alignment, compact continuous command previews, unchanged execution of original multiline scripts, CR/LF and indentation folding, preserved inline spaces, post-folding length limits, one-second refresh, empty/output-error states, bounded sanitized output, long commands, narrow/CJK widths, arrows/Enter/click selection, selected-ID stability across completion, `x` cancellation, closing without stopping, history paging and timer disposal. The old `viewer.mjs` was removed because all of its Herdr tab/pane/follow-script contracts are retired; local execution, process-tree cleanup and notification assertions remain in their existing suites. `extension.mjs` additionally checks no slash commands, one panel at a time, inspection not consuming reminders, and shutdown closing the panel.
- `media.mjs`: actual demo Python jobs stream in-place/line output and exit with 0/3 only after explicit release files; the offline provider issues exactly two direct starts, then returns without polling. This tests the fixtures used by the real recorder, not an invented screen.
- `notifications.mjs`: isolated real Pi with model-issued background calls, default one-at-a-time queues and an offline provider. Sequential blocking fixtures hold one native tool batch open across two waves of actual failing shell jobs. The blocking fixture runs directly or through native Codemode, but background calls always come from the model. The next model request gets one merged notification for four completions, excluding reminders for zero, one or two first-wave terminal outputs read directly by the model before the boundary; no output bodies are attached to any completion notice; no extra requests follow the final report. An accelerated production registration also proves that real Pi receives repeated idle progress turns before the real shell completes, then receives one completion turn. Also verifies distinct declaration/start guidance without a Codemode suffix and that native Codemode cannot discover or call `background_task`. `BG_TEST_EXTENSION=/absolute/path/to/background-tasks.ts` can run the queue regressions against an older implementation.
- `compaction.mjs`: isolated native Pi SDK sessions call `session.compact()`, the same manual-compaction entry point used by `/compact` and RPC. Real shell jobs exit during a held offline summary request. Covers successful native compaction, a provider summary error and `abortCompaction()` cancellation; each must retain the pending completion while busy and automatically deliver status/log-location metadata once afterward, without another user prompt. Checks actual compaction lifecycle/events, saved compaction entries, completion timestamps/logs and exactly one automatic conversation request. Uses real timers and native `isIdle`/`isCompacting`, not injected busy state or replacement compaction results; no paid model call or TUI keyboard invocation of `/compact`. `BG_TEST_EXTENSION` also supports a negative-control extension.
- `interruptions.mjs`: isolated native Pi SDK sessions call the real `session.abort()` while a foreground tool is held. A real shell finishes before or after the interrupt; terminal timestamps verify the ordering. Native `agent_settled.aborted` must confirm the stop; no completion may start another model request. A new user prompt sees the retained completion in its first request, reads the real failed task's output, and finishes without duplicate delivery or extension errors. A third case starts actual manual compaction while the foreground tool is held: Pi itself interrupts the active agent, which must stay stopped even after compaction and background completion. The public abort event has no reason field, so the extension preserves this native interruption rather than guessing its source. `BG_TEST_EXTENSION` supports a negative control without interrupt suppression.

The compaction fixtures seed a completed earlier turn and sufficient recent context explicitly; their ability to compact must not depend on how verbose the start result is. Active-compaction interrupt cases count their completed warm-up request separately.

Compaction cancellation assertions use native lifecycle `aborted` flags and the absence of a saved compaction entry, not version-dependent error strings. Agent interruption is a different state and is tested separately.

Notification retry tests use the injected clock and session-idle interface. They check the 1/2/4/8/16/30-second completion delays and the separate 30-minute progress deadline, retention across 24 hours of busy time, one aggregate progress turn for all running tasks, immediate boundary delivery, fresh-batch reset, and cleanup on terminal reads, abort/error boundaries and session replacement. No compression-event subscription or notification pause action is introduced. Offline fixtures prove guidance delivery, not that a live model always obeys it; no paid/live-model anti-polling evaluation is part of this suite.

Load-test uses an isolated temporary agent directory, the production extension and an offline fixture provider. It does not access real provider credentials or alter the user's installed packages. From the workspace, `npm --prefix packages/background-tasks run load-test -- --toolkit` loads the complete toolkit directory through its manifest and verifies exactly one background-task tool; the root load-test runs this check too.

The deterministic registration test checks the approved per-task-log sentence in the `command` parameter description. The native offline-provider test verifies it is visible in the first model request, before starting a task.

## Real Pi TUI

Requires Python 3 with the existing `pexpect` module; process fixtures use Bash, Python and `ps`. The current native-process/TUI suite is verified on Linux.

```bash
python3 packages/background-tasks/tests/tui-smoke.py .cache/verification/background-tui
BG_SMOKE_TUI_MODE=regular python3 packages/background-tasks/tests/tui-smoke.py .cache/verification/background-tui-regular
```

This starts a real Pi in a PTY with the production extension, Scheduler, the built-in Codemode tool and a deterministic fixture provider. It checks two jobs, rejection of a third, model turn completion while jobs remain alive and rejection of Codemode background calls, explicit output, cancellation, automatic main-agent notification, reload/new/quit cleanup and log removal. It observes both persisted boundary entries and idle custom messages by unique session-entry ID, and rejects duplicate notifications. No network model calls occur. Mocked UI tests separately verify the exact five-second boundary.

Results and the actual ANSI stream are stored under the chosen evidence directory. Real screenshots require an isolated X11 terminal window, `gnome-terminal.real`, `xwininfo` and ImageMagick `import`:

```bash
gnome-terminal.real --wait --window --title='Pi Background Tasks Smoke' --geometry=140x42 -- \
  env BG_SMOKE_RENDER=1 BG_SMOKE_CAPTURE=1 python3 \
  "$PWD/packages/background-tasks/tests/tui-smoke.py" "$PWD/.cache/verification/background-tui-live"
```

It relays the real PTY output, captures only the test window, then closes it. Inspect the running, completed and history screenshots; check the widget has disappeared in the last one. Provider decisions are fixtures; tool execution, shell jobs, queues, TUI and cleanup are real.

## Browser/TUI flow and media

```bash
node scripts/capture-background-tasks-media.mjs .cache/background-ui
BG_MEDIA_EDITOR=none node scripts/capture-background-tasks-media.mjs .cache/background-ui-no-editor
node scripts/capture-package-media.mjs background-tasks
```

Requires Python 3, Chrome, the web-browser skill launcher, Pillow and an installed `@xterm/xterm` package. Set `XTERM_DIR` to its package directory if it is not under `~/.pi/agent/npm/node_modules/@xterm/xterm`. No Herdr or graphical desktop is required.

The recorder starts a real Pi PTY with the production extension and offline provider. By default it also loads the production Codex Edit extension; that offline model correctly selects `editor: edit`. Deterministic tests additionally cover `editor: apply_patch`. `BG_MEDIA_EDITOR=none` verifies the same flow without an editor extension. Chrome renders the actual ANSI stream through xterm.js in a recorder-owned temporary browser profile, without touching an existing skill browser. CDP sends real mouse press/release events to the shell counter and task rows, and keyboard events for selection, return, close, stop and Alt+J. It asserts that the count is on the last nonempty row beside editor status when present, with no duplicate above the footer. Both list and details hide path, usage, model and status rows; closing restores them. A real four-line script with two exports must preview continuously, with the actual job command visible on the same row. It also verifies aligned fields, live output, completion, cancellation, retained history and session-log cleanup. The Python bridge only transports PTY bytes; it does not draw replacement UI. Its local HTTP/WebSocket server uses a random path token and same-origin upgrade checks and is closed after the run.

The unified media entry first runs `tests/tui-smoke.py`, then the browser/TUI recorder. `result.json`, tool events and raw screen text/screenshots are saved under `.cache/package-media/background-terminal`. The renderer builds `docs/screenshot.png`, `docs/shell-list.png` and `docs/demo.gif` from real captured states. The old Herdr pane screenshot and WebM are retired.

Inspect the gallery in Chrome: `docs/package-media-gallery.html`. Verify images load and the GIF shows counter → details → list → selected details → completion/cancel → history. Record results in `docs/verification.md`.

```bash
node tests/package-layout.mjs
node tests/release-check.mjs
npm test
npm run load-test
npm pack --dry-run
git diff --check
```

Missing Chrome, a failed interaction or a skipped real-TUI check blocks release acceptance. Deterministic suites alone do not verify the mouse path.
