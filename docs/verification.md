# Package split verification

## Issue #21: explicit Herdr Subagents extension sources (2026-10-13)

- `npm --prefix packages/herdr-subagents test`: 266 assertions passed, 0 failed. New cases cover Markdown/JSON source lists, precedence, clearing, diagnostics, npm/local argument preservation, unchanged mandatory extensions/tool allowlists, durable history, historical resume, blocked-task restart, and queued-task recovery.
- `PI_TEST_BINARY="$(command -v pi)" npm --prefix packages/herdr-subagents run load-test`: extension contracts, production entrypoint, and real Pi 1.2.0 file/package fixtures passed. Package skills and prompt templates loaded despite discovery flags; the explicit child tool allowlist stayed unchanged.
- `HERDR_SUBAGENTS_E2E_MODEL=opencode-go/deepseek-v4-flash npm --prefix packages/herdr-subagents run test:real-herdr`: one unconfigured child and two concurrent read-only children with an explicit package completed, wrote matching attempt reports, and closed their tabs. The concurrent children also loaded the package extension and skill and retained their source configuration.
- `npm test`: root and all child suites passed, including 18 Cache Export browser E2E assertions with 0 skips. `npm run load-test`, child/root `npm pack --dry-run`, and `git diff --check` passed. Both tarballs contain the new native loading check.
- npm/git identifiers were tested at the child launch-argument boundary. Online npm/git installation was not exercised; source installation remains delegated to Pi. Media was not regenerated for this configuration-only change.
- Earlier runs exposed existing asynchronous cleanup timing sensitivity: two deterministic deferred-cleanup assertions failed once, and the first real concurrent smoke observed a surviving pane immediately after cleanup. Subsequent complete runs passed without changing cleanup production code or weakening assertions.
- The first native load check under npm selected the workspace's Pi 0.85.1, which lacks the required native CLI features. The passing check explicitly selected the installed Pi 1.2.0 through the documented `PI_TEST_BINARY` test override.


## Deferred-cleanup failure investigation (2026-10-13)

- **Confirmed test-timing defect:** `tests/cleanup-timing.mjs` holds the actual run-state lock across the old 10 ms assertion point. Both successful cleanup and error persistence remain legitimately pending at that point, then settle correctly after release. The suite now waits for observable durable commits/notifications with a deadline, not a larger fixed sleep.
- **Confirmed real-smoke false-failure path:** intentionally focusing the concurrent test tab reproduced `hello-one pane survived tab cleanup`. The preserved trace at `/tmp/pi-herdr-subagents-real-P0kU7l` recorded `isTabFocused=true`, `cleanupPendingTabIds`, and a live focused tab. This is the documented deferred-cleanup behavior, not evidence of a production cleanup failure.
- **Controlled recovery:** the tracked `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1` mode requires the pending state, restores the actual previously focused tab, and verifies automatic pane removal and cleanup-record commit. It passed without manually closing the test tab. The ordinary real smoke now has a five-second cleanup deadline and fails immediately on a durable cleanup error.
- **Evidence retention:** smoke failures save task/session/run records, `trace.json`, and `failure.json` with live tab/pane snapshots before teardown. Teardown errors also fail the check and retain the directory. Only successful checks delete temporary records.
- **Repeat verification:** five ordinary real-smoke runs passed during diagnosis. After the test fixes, three complete deterministic suites and three ordinary real-smoke runs passed; the controlled-focus mode also passed. Original failure logs remain under `.cache/verification/`.
- **Focus-scope correction:** a later optional-focus probe failed visibly because the user was viewing another workspace, so the caller workspace had no focused tab. Its evidence remains at `/tmp/pi-herdr-subagents-real-s4HfvY`. The probe now discovers the globally focused workspace's actual `active_tab_id`, explicitly restores both workspace and tab, and asserts both IDs after automatic cleanup. The corrected probe passed with the user viewing workspace `w4` while the parent ran in `wB`; the final Herdr snapshot confirmed `w4` remained focused.
- **Limits:** the first historical real-smoke failure had already lost its state, so its exact cause cannot be reconstructed. The investigation reproduced a sufficient false-failure condition and fixed that test assumption. Production `tab-cleanup.ts` and its callers were not changed.

Last baseline run: 2026-10-10

This report covers the root bundle and the six independently releasable packages after adding Scheduler. Raw command output is stored locally under `.cache/verification/` and is intentionally ignored by Git.

## Required checks

| Check | Expected result |
|---|---|
| `node scripts/capture-package-media.mjs` | Regenerates real-output media; the five GIF packages have three distinct frames and Herdr retains its screenshot plus WebM. |
| `npm test` | Root layout, BTW, Todo, all child deterministic tests, Cache Export Chromium E2E, Worktree installer, and CLI integration pass. |
| `npm run load-test` | Every configured extension entrypoint loads successfully. |
| `npm pack ./packages/<slug> --dry-run` | Each child tarball contains its runtime, documentation, screenshot, and demo. |
| `npm pack --dry-run` | The root bundle contains root-only assets and the child runtime sources referenced by its manifest. |
| `git diff --check` | No whitespace errors. |

## Baseline results

- Cache Export: 47 deterministic assertions and 18 Chromium E2E assertions passed, with 0 failures and 0 skips.
- Codex Edit: 22 Node tests and 12 shared comparison cases passed, including real Pi native-edit versus local Codex Edit, released versus local parser, deterministic report regeneration, and outside-workspace safety comparisons.
- Herdr Subagents: 194 scheduler, recovery, schema, navigation, persona, lifecycle, attempt-isolation, and process-boundary tests passed. A real Herdr smoke completed a read-only package inspection with matching durable attempt/report IDs and automatic tab cleanup. Deterministic extension coverage also verifies delayed reports after false screen settlement, blocked dispatcher/Fleet ownership, serialized responses with explicit stale-lock diagnosis, cleanup warnings that preserve business status, mixed failed/cancelled aggregation, and global/project default thinking precedence.
- Scheduler: fake-clock and extension integration tests passed for duration parsing, drift-free cadence, missed-tick coalescing, Agent/user controls, manual and timed triggers, message-specific pending acknowledgement, follow-up delivery, TUI status, cancellation, and shutdown timer cleanup. Its screenshot and three-frame GIF were regenerated from the production scheduler state machine.
- Todo, BTW, Worktree installer, and Worktree CLI integration tests passed.
- Media: all six screenshots are non-empty; Cache Export is a full-page 1440 × 2278 capture; Herdr Subagents includes a live WebM recording that moves from the parent Pi through each of three focused Agent panes and back to the final parent summary, with no GIF; the other five GIFs contain three distinct frames.


## OpenAI Account Pool (2026-10-13)

Run from the `codex-pool` worktree with Node v22.23.2 and Pi 1.2.0. No account identity or credential was displayed, logged, or published.

- `npm --prefix packages/openai-account-pool test`: eight deterministic suites passed - credential ownership, selection and classification policy, login-slot ownership, enrollment wizard, live-usage normalization and races, stream failover, real multiprocess locking, and the login-ownership integration check.
- `tests/multiprocess.mjs` uses real child processes, not simulated ones: two pi processes racing an expired rotating refresh token exchanged it exactly once, both ended up on the same live credential, and the loser reported no refresh. Four children writing concurrently with the parent lost no unrelated provider entry, and a valid credential was never refreshed.
- `tests/failover-stream.mjs` covers the rules that matter for correctness: only a structured `usage_limit_reached` switches accounts, a plain 429 with the same friendly wording does not, nothing is replayed once output has reached the user, the proven limit is recorded even then, and an exhausted pool forwards the provider's own error plus a note.
- `PI_TEST_BINARY="$(command -v pi)" npm run load-test`: all seven extension entrypoints loaded under real Pi 1.2.0, including `packages/openai-account-pool/extensions/openai-account-pool.ts`. The package's own `load-test` loaded it in a sessionless Pi as well.
- `npm pack ./packages/openai-account-pool --dry-run` (29 files) and `npm pack --dry-run` (190 files) both contain the runtime, tests, documentation, screenshot, and demo. `git diff --check` reported no whitespace errors, and `npm test` at the root passed with all 47 checks.
- A read-only live `wham/usage` query reached both configured pooled accounts through the implemented client. Both returned the expected primary and secondary windows, reset times, `allowed: true`, and `limit_reached: false`. Only account ordinals, percentages, and booleans were emitted. The two Herdr reviewer sessions also loaded this extension and completed real `openai-codex` model turns through the synthetic pool reference, proving child Pi can resolve pooled credentials.
- Media was regenerated from real module execution: `node scripts/capture-package-media.mjs openai-account-pool` drives `runEnrollment`, `poolStatus`, and a real `createPoolProvider` request whose first account returns `usage_limit_reached`. The GIF has three distinct frames. Scanning the package, the screenshot, and the GIF found no token-shaped string or authorization callback URL; the only matches are the synthetic fixtures in `tests/enrollment.mjs` that assert redaction.
- Fixture credentials exist only inside per-test temporary agent directories, which the tests delete, and account identifiers are masked everywhere they are shown.

### Defects found and fixed during verification

- The lock identified its own hold by inode and millisecond mtime. On this filesystem a directory recreated immediately reuses both, so a reclaimed lock could go unnoticed; the deterministic test caught it intermittently under full-suite load. Ownership is now a unique sub-millisecond heartbeat stamp we write ourselves, and it is re-checked immediately before each write instead of relying on a heartbeat having fired. Filesystems that keep only whole milliseconds degrade to proper-lockfile's own mtime check.
- Reviewer reproductions found that a stale available usage response could erase newer quota evidence, an active cross-process probe lease could be bypassed, private-endpoint reads were not bounded while streaming, failed live status could present stored exhaustion as available, recovery estimates mixed unrelated model cooldowns or partial unknown resets, and refresh errors retained raw text. The usage write and evidence clearing are now one freshness-guarded transaction; leases always block other owners; usage reads have per-account time and byte limits; status retains known exhaustion; estimates share model scope and reject unknown blockers; errors collapse to a non-secret code. Deterministic regressions cover each behavior.

### Not executed

- A naturally occurring live failover between real accounts was not executed because neither account was exhausted. No paid quota was deliberately consumed. Structured quota failover remains covered through the real provider stream plumbing with fixture HTTP responses.
- Full media regeneration for every package. `scripts/capture-herdr-subagents-media.mjs` requires a visible Herdr X11 session, so only the `openai-account-pool` slug was captured; the other packages keep their existing committed media.
- Interoperability with Pi's own credential writer was verified against a test double that speaks the same on-disk lock protocol, not against a concurrently running Pi process.

Open [`package-media-gallery.html`](package-media-gallery.html) to inspect every generated PNG, GIF, and video in one page.
