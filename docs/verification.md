# Package split verification

## Codex Edit: persistent user configuration

- Added `src/config.ts`: read bundled defaults, then field-level overrides from `<agent-dir>/codex-edit.json` using Pi's `getAgentDir()` (`~/.pi/agent` by default, honoring `PI_CODING_AGENT_DIR`). Model arrays replace defaults; false and empty arrays remain explicit. Missing user files are allowed; malformed, invalid or unreadable files report their path. No project config, file watcher, automatic migration, package-default change or model/API routing change was added.
- Observed the new isolated config test fail before implementation. Child tests now include seven config checks (29 Node tests total), with a Pi-loaded integration harness that calls the production extension factory through mocked event/tool-selection interfaces for parent/child cwd independence, API/model switching, read-only tools, reload and malformed input. The registered production patch tool writes and verifies a real temporary file. This is not a real Herdr child or model-quality benchmark.
- `npm --prefix packages/codex-edit test`: passed all five report checks, including native/local and frozen released/local comparisons, entrypoint loading, config integration and packing. Regenerated `docs/test-report.md`, `docs/test-report.html` and `docs/test-summary.md`; historical 300-chain benchmark evidence and parser corpus are unchanged.
- `npm --prefix packages/codex-edit run load-test`, full root `npm test`, root `npm run load-test`, child/root `npm pack --dry-run`, and `git diff --check`: passed. Root tests included Cache Export's 18 browser E2E checks with zero skips. Both tarballs include the new config loader and tests. Root AGENTS and manifests were reviewed; runtime loadout and dependencies need no change, and only the child test/load scripts changed.
- Created the requested personal `~/.pi/agent/codex-edit.json` outside the repository with the unchanged `gpt-5.6-*` rule plus the exact `gpt-6.1-sol` opt-in, and verified the new loader routes it on the supported API. No wildcard expansion to other model families or new paid model-quality benchmark was performed.
- No installed npm files, Herdr settings, media, versions, commits, tags or publications were changed. The running installed extension remains unchanged; `/reload` only gains this capability after the new implementation is installed or explicitly loaded. Existing child processes retain their previous loadout/configuration.

## Manual Agent Team and post-release verification

- Agent Team now sets `disable-model-invocation: true`; its description and body no longer authorize automatic activation. README and AGENTS document `/skill:agent-team` as the explicit entrypoint. Package-layout regression checks pin the flag and command.
- Added `scripts/post-release-check.mjs` / `npm run release:check`, with offline fixtures for root-only and coordinated initial-child releases, workflow discovery/wait/failure, shared timeout, npm propagation/auth/version/commit/integrity failures, missing or modified tarball files, dirty-checkout isolation, and CLI validation. Both release scripts print the exact follow-up command.
- `npm test` and `npm run load-test`: passed. Post-release fixtures: 22 assertions. Root `npm pack --dry-run`: passed; 185 files, including the updated Agent Team skill. `git diff --check`: passed.
- Live read-only check: `npm run release:check -- v0.13.1 --timeout 120 --interval 5` passed against commit `8f2b97782eca519a0f09324539a985e7375674d2` and [publish run 39535496464](https://github.com/chaochaoxiaochao/pi-toolkit/actions/runs/39535496464). Verified remote tags, npm metadata/integrity, 55 child files for `@maxiaochao/pi-herdr-subagents@0.7.2` and 185 root files for `@maxiaochao/pi-toolkit@0.13.1`, including bytes and modes, against isolated tag snapshots despite the dirty checkout.
- No version bump, commit, installation, publication, media regeneration or change to the running Pi loadout was performed. The new check is repository tooling, not a bundled runtime entrypoint. Local packing deliberately ignores scripts; packages that introduce generated prepack output need the verifier updated.

## Background Tasks bundled by default (2026-10-20)

- Follow-up requirement supersedes the initial optional-install decision below: the toolkit now embeds and enables Background Tasks by default, alongside the five previously bundled children. The standalone child remains available as an alternative; documentation warns against installing both.
- Added the child directory to root `files`, its extension to root `pi.extensions`, and both extension/full-toolkit checks to root `load-test`. The root Pi peer minimum is now 1.3.0, matching the embedded feature. No wrapper, npm child dependency, extra global prompt rule or runtime behavior change was introduced.
- First reproduced the missing default bundle with a failing package-layout check, then updated the manifest and assertions. The isolated real-Pi load probe now covers both standalone and explicit toolkit-directory loading; it asserts exactly one registered **and model-visible active** `background_task` without manually activating it.
- Re-ran child tests (41 passed, zero skips), standalone load, full root `npm test`, root `npm run load-test`, package layout and release routing. Root tests again include 18 Cache Export browser E2E checks with zero skips.
- Child/root dry-run packs passed: 19 child files and 185 root files. All 19 Background Tasks files are embedded in the root pack, including its extension, source and media. The root loadout references its extension exactly once. README, both changelogs, AGENTS, TESTING and gallery labels now match default bundling.
- Chrome CDP rechecked the updated gallery heading and image loading, captured a screenshot and opened the screenshot link with an actual pointer click. Runtime/media rendering is unchanged, so existing real-TUI PNG/GIF remain valid. Evidence: `.cache/verification/background-bundled-*`. No install, commit, version bump or publication was performed.

## Initial optional Background Tasks implementation (2026-10-20)

- Implemented in the `background-tasks` worktree, under `packages/background-tasks/`. The package owns local shell jobs, not subagents: two concurrent slots, a default 30-minute runtime limit (maximum 2 hours), bounded private logs, explicit cancellation, followUp completion notifications and an above-editor widget. It adds no global promptGuidelines.
- Observed tests fail before implementation. Later output review exposed an oversized newline-terminated line losing its displayed tail; added a native-Bash comparison before correcting the bounded read window. Also reproduced and fixed explicit null timeout acceptance and an I/O error being hidden while cancellation drained output.
- `npm --prefix packages/background-tasks test`: **41 passed, 0 failed, 0 skipped**, using installed Pi 1.3.0 peers without installing dependency copies. Covers fake-clock/runtime races and limits, UTF-8 and native Bash output comparisons, actual shell/PID cleanup, disk failures, strict input handling, bounded metadata/history, tool/command parity, parent-abort independence, followUp and widget lifecycle.
- Real native process checks passed for immediate return, simultaneous commands, a Python heredoc build-log check, a silent busy loop terminated after one second, cancellation/shutdown of a shell and its waiting child, and stopping output at the default 32 MiB disk cap. The original 60-second delayed Python/PID/exit-file scenario also passed: accepted immediately and completed successfully after **60.03 seconds**.
- Real Pi TUI smoke passed with an offline deterministic provider, built-in Codemode, Scheduler and the production background-task extension. Verified two jobs and third-start rejection, Codemode completion while jobs keep running, `/bg output`, cancellation, completion followUps that wake the same main agent, finished rows disappearing after five seconds, and process/log cleanup on reload, new session and quit. New/resume/fork/reload/quit shutdown paths also have deterministic extension tests. The fixture controls model decisions only; shell execution, Codemode, queues and UI are real.
- `npm --prefix packages/background-tasks run load-test`: passed in an isolated temporary agent directory, confirming exactly one registered background-task tool. Standard root `npm run load-test` passed for the unchanged default loadout. An extra Pi 1.3.0 root-load probe initially hit a personal credential parsing error before execution; rerunning all six root entrypoints with an isolated agent directory and the offline fixture passed without accessing or changing real credentials.
- Full root `npm test`: passed, including the new 41 checks, package layout, release routing, all existing child suites and BTW history. Existing Cache Export browser E2E reported **18 passed, 0 failed, 0 skipped**.
- `node scripts/capture-package-media.mjs background-tasks`: passed. The screenshot and three-frame GIF come from an isolated real GNOME terminal relaying the real Pi PTY, not hand-filled results. Inspected running/completed/history frames; Scheduler stays visible and the final frame has no background widget. Only the new package's media was regenerated.
- Real headless Chrome CDP checks passed for `docs/package-media-gallery.html`: desktop and iPhone 14 layouts, no broken images or horizontal overflow, and actual pointer clicks opening the new PNG and GIF. Captured browser screenshots and click results.
- Child/root `npm pack --dry-run`: passed. Child: **19 files**, including source, tests, docs, PNG and GIF, with no node_modules, logs or Python caches. Root: **166 files**, with **no packages/background-tasks/** entry. Layout and release-routing tests passed; root default extensions/load checks remain unchanged. `git diff --check` passed.
- Evidence is under `.cache/verification/background-*` and `.cache/package-media/background-live/`. No installation into the personal Pi loadout, commit, version bump, tag or publication was performed. Runtime uses Pi's public process backend; detached/daemonized children and cleanup after SIGKILL/power loss remain explicitly unsupported. No Windows-native TUI/process verification was claimed.


## Herdr Subagents: Persona responsibilities (2026-10-20)

- Observed new checks fail before changing the definitions: the parent-facing analyst description did not identify agent-team, and the Agent Team skill did not explicitly select analyst for Persona dispatch.
- Updated the English descriptions and bodies for analyst, reviewer, and explorer; kept worker, tool allowlists, access declarations, scheduling, and Persona resolution unchanged. Updated the model-facing tool description and the Chinese Agent Team skill's Persona selection guidance. Reviewed root AGENTS and both manifests; no changes were needed.
- `npm --prefix packages/herdr-subagents test`: passed. New checks cover effective parent-facing descriptions, broad reviewer scope, charter-driven analyst instructions, explorer investigation, body delivery in actual child system-prompt files, and unchanged access/tool boundaries. `node tests/package-layout.mjs`: passed, including the new Agent Team Persona selection check.
- An actual `reviewer` subagent independently reviewed the working-tree changes and found one stale analyst wording assertion in the deprecated migration suite. Updated that assertion and ran it in isolation; it passed. The complete deprecated legacy lifecycle suite was not run because it tests retired workflows.
- `npm --prefix packages/herdr-subagents run load-test` with the installed Pi selected through `PI_TEST_BINARY`, and `npm run load-test`: passed.
- `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1 npm --prefix packages/herdr-subagents run test:real-herdr`: passed for one real child and two concurrent read-only children, including deferred cleanup while focused, restored focus, and automatic tab cleanup. This verifies execution and cleanup, not a guarantee that every future model will select the intended Persona.
- Root `npm test` initially failed at the existing `tests/release-check.mjs:18` assumption that an account-pool release check cannot include a Herdr smoke when Herdr has uncommitted changes. The same limitation was recorded in the earlier explicit-Persona verification below. Left release tooling unchanged. After committing the implementation, the full root `npm test` passed, including release-routing checks, all child suites, BTW history, and 18 Cache Export browser E2E checks with zero skips. Before the commit, those subsequent suites also passed when run separately.
- Child/root `npm pack --dry-run` and `git diff --check`: passed. Raw logs are under `.cache/verification/persona-*.log`.
- No media regeneration or local installation was performed. There is no UI layout change. Version bumps and tags use the coordinated release script; installed/running package definitions remain unchanged until the updated package is installed and loaded.

## Herdr Subagents: default extension sources (2026-10-15)

- Added `tests/config.mjs` and observed it fail before implementation because `defaultExtensions` was ignored. The active package test command now includes it.
- `npm --prefix packages/herdr-subagents test`: passed. Covers global/project defaults, whole-array replacement, trimming, JSON/Markdown precedence, explicit empty lists, invalid-value diagnostics, source attribution, per-call reloads, control listings, settings output, and preservation of mandatory child extensions.
- `npm --prefix packages/herdr-subagents run load-test`: passed. Real Pi loaded a local file and package resolved through global `defaultExtensions`, including package skills/prompts, without broadening the tool allowlist.
- `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1 npm --prefix packages/herdr-subagents run test:real-herdr`: passed for one real child and two concurrent read-only children using global defaults. Verified durable extension lists, package resources, deferred cleanup while focused, restored focus, and tab cleanup.
- Child and root `npm pack --dry-run`: passed (55 and 165 files); both include the new configuration test. `node tests/package-layout.mjs` and `git diff --check`: passed.
- Updated both READMEs, TESTING, and both changelogs. Reviewed root AGENTS and manifests: no instruction, dependency, loadout, or packaging changes needed; only the child test script changed. No root runtime, UI layout, media, installed configuration, or release was changed. The unrelated full root suite and deprecated legacy lifecycle suite were not run.

## Herdr Subagents: explicit task Personas (2026-10-15)

- Reproduced three failures before fixing them: missing `agent` silently selected `worker`, the registered schema did not require `agent`, and parallel-write errors did not identify the conflicting task/Persona.
- `npm --prefix packages/herdr-subagents test`: passed. Coverage includes absent/blank/non-string/unknown Personas, a missing Persona on a later task, legacy single-task normalization, rejection before creating run records, explicit serial `worker`, read-only parallelism, custom Persona names, and actionable write-conflict errors.
- `npm --prefix packages/herdr-subagents run load-test`, `npm run load-test`, and an isolated real-Pi startup probe: passed. The probe inspected the actual registered tool and confirmed `tasks[].agent` is required.
- `HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP=1 npm --prefix packages/herdr-subagents run test:real-herdr`: passed for one real child and two concurrent children, including deferred cleanup while focused, restored workspace/tab focus, and automatic tab cleanup.
- Child and root `npm pack --dry-run`: passed (54 and 164 files). `node tests/package-layout.mjs` and `git diff --check`: passed.
- Root `npm test` initially failed at `tests/release-check.mjs:18`: the routing fixture assumes no uncommitted Herdr changes. After committing the implementation, the full root `npm test` passed without changing the release scripts.
- All package suites and BTW passed, both separately and in the full root run. Cache Export browser E2E completed 18 checks with zero skipped; Codex Edit regenerated its reports without leaving changes.
- Reviewed root AGENTS and both manifests; no instruction, dependency, or packaging changes were needed. Role prompts and skills remain unchanged. No media regeneration or local installation was performed; installed/running sessions are unchanged. The required task parameter is an interface change, so the coordinated release uses minor version bumps for both 0.x packages.

## OpenAI Account Pool: missing session marker (2026-10-14)

- Reproduced before the fix with `tests/integration-session-status.mjs`: after a fixture quota failure on account #2 and successful failover to account #1, a fresh command context rendered account #1 without `●本会话`.
- Keyed successful-account state and provider installation by `sessionManager.getSessionId()`. Status and preference commands no longer reinstall the provider or resample the session preference. Shutdown clears the session's state.
- `npm --prefix packages/openai-account-pool test`: all ten suites passed. The new production-extension test uses Pi's real loader, runner and session manager; it covers TUI/RPC markers after failover, repeated command contexts, provider installation count, new-session isolation and first success, and shutdown/restart cleanup.
- `PI_TEST_BINARY="$(command -v pi)" npm --prefix packages/openai-account-pool run load-test`: exit 0.
- `npm pack ./packages/openai-account-pool --dry-run`: 33 files, including the new integration test.
- `node tests/package-layout.mjs` and `git diff --check`: passed. Reviewed root README/AGENTS and manifests; installation boundaries are unchanged.
- No real-account quota exhaustion, live terminal failover, media regeneration, or publication was performed. The tests use isolated temporary credentials and fixture HTTP responses only; the status layout itself is unchanged.

## Unbundling OpenAI Account Pool from the toolkit (2026-10-14)

`pi install npm:@maxiaochao/pi-toolkit` no longer enables `@maxiaochao/pi-openai-account-pool`.

- `node tests/package-layout.mjs`: passed. The layout test now requires `openai-account-pool` to be absent from the root `files` entry, the root `pi.extensions` loadout, and the root `load-test`, exactly as it already required for `todo`. It also pins the root release-changelog note, because that note may no longer claim every child is bundled.
- `npm test`: exit 0. Root layout, BTW, and every child suite passed, including the eight OpenAI Account Pool deterministic suites, which the root test script still runs.
- `npm run load-test`: exit 0 for the six remaining configured entrypoints (Cache Export, BTW, Codex Edit, Herdr Subagents, Scheduler, Worktree).
- `npm --prefix packages/openai-account-pool run load-test`: exit 0. The removed entrypoint is verified through the child package's own documented command.
- `npm pack --dry-run`: 162 files, down from 190. The tarball contains `packages/cache-export`, `packages/codex-edit`, `packages/herdr-subagents`, `packages/scheduler`, and `packages/worktree`, and no `packages/openai-account-pool`.
- `npm pack ./packages/openai-account-pool --dry-run`: 32 files; the standalone tarball still contains its runtime, tests, documentation, screenshot, and demo.
- `npm --prefix packages/herdr-subagents run test:real-herdr`: one real child Agent and two concurrent real child Agents completed and cleaned up.
- `git diff --check`: no whitespace errors.

### Not executed

- `pi install npm:@maxiaochao/pi-toolkit` was not run against the real Pi installation, because that rewrites the personal loadout. The root manifest, the layout test, and the packed tarball contents cover the same declaration.
- `@maxiaochao/pi-openai-account-pool@0.1.1` stays published on npm unchanged, and no npm deprecation was issued for it.
- No media was regenerated: this change alters packaging and documentation only.

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
