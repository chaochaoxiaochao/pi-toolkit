## 2026-10-28 - v0.13.17

- bundle the explicit-only mermaid skill for Markdown diagrams and text wireframes; prune global AGENTS.md guidance

## Unreleased

- Move the personal `mermaid` skill into the toolkit's bundled skills, preserving explicit-only invocation.
- Clarify Mermaid preview verification and examples for choosing diagrams versus text wireframes; drop Pi-terminal rendering rules.
- Prune global AGENTS.md: drop no-op lines, merge the anti-sycophancy rules into one positive instruction, and scope worktree isolation to changes spanning more than one module.

## 2026-10-27 - v0.13.16

- refine global verification and skill-boundary guidance; require independent evaluation and direct correction of flawed premises

## 2026-10-27 - v0.13.15

- worktree v0.4.2: support removing multiple worktrees in order
- Allow bundled pi-worktree to remove multiple worktrees in one command.

## 2026-10-26 - v0.13.14

- herdr-subagents v0.7.6: Esc in a child waits abortGraceSeconds (default 30) for a correction before publishing child_aborted

## 2026-10-26 - v0.13.13

- background-tasks v0.1.2: restrict background tasks to model-only and use concise automatic-notification guidance

## 2026-10-23 - v0.13.12

- worktree v0.4.1: return the worktree root from already-active nested directories

## 2026-10-23 - v0.13.11

- openai-account-pool v0.1.9: classify forced refresh failures and prevent output replay

## 2026-10-23 - v0.13.10

- codex-edit v0.2.1: preflight path hierarchy conflicts and preserve moved-file permissions

## 2026-10-23 - v0.13.9

- cache-export v0.1.1: correct request timing, usage scope and historical cache evidence

## 2026-10-23 - v0.13.8

- herdr-subagents v0.7.5: bound missing-report recovery and close unconfirmed child outcomes
- Cache Export: use request timing and historical, non-secret cache-policy observations; separate auxiliary usage, mark unknowns, and resolve exports against the session cwd.
- BTW: seed main and restored side history through SessionManager instead of transient agent state.
- Herdr Subagents: one durable child-side missing-report reminder; terminal diagnostics for unconfirmed results, cancellation, and final errors without parent-side wake-up logic.
- Codex Edit: preflight file/parent conflicts before writing and preserve ordinary file permissions on moves.
- OpenAI Account Pool: classify forced-refresh failures consistently and prohibit authentication repair after output delivery.
- Worktree: return the worktree root from already-active nested directories.
- web-browser: refuse profile mutation while Chrome is active, including another port or missing launcher state.

## 2026-10-23 - v0.13.7

- openai-account-pool v0.1.8: fix stranded account-pool references after removal and recover email labels

## 2026-10-22 - v0.13.6

- background-tasks v0.1.1: batch unread completions at tool boundaries, preserve interrupted runs, and provide non-polling startup guidance

## 2026-10-22 - v0.13.5

- herdr-subagents v0.7.4: preserve Codex patch editing in child allowlists and hide the parent shortcut footer hint
- Herdr Subagents: hide the child parent-navigation footer hint while keeping `Alt+P`, `/parent`, and other extensions' editor status.
- Herdr Subagents: permit `apply_patch` in edit-capable child CLI allowlists so editor switching does not remove the only active editing tool; preserve read-only limits and native fallback.

## 2026-10-22 - v0.13.4

- herdr-subagents v0.7.3: keep Persona selection lists concise

## 2026-10-21 - v0.13.3

- codex-edit v0.2.0: persist personal routing rules in the Pi agent directory across package updates
- Codex Edit: read persistent personal routing overrides from `~/.pi/agent/codex-edit.json` (respecting `PI_CODING_AGENT_DIR`), shared by parent sessions and explicitly configured subagents; validate user settings and preserve the bundled defaults.

## 2026-10-21 - v0.13.2

- make agent-team user-invoked only and add post-release workflow/npm/tarball verification

## Unreleased

- Global instructions: add cognitive objectivity and anti-sycophancy rules for leading questions, independent verification, and direct correction.
- Global instructions: consolidate verification and completion criteria, clarify skill inspection exceptions, and remove duplicate simplicity guidance while preserving ASD-STE100 requirements.

- Background Tasks: fix tool exposure to `model-only` and shorten startup guidance to English, emphasizing automatic notification without sleep or polling.

- OpenAI Account Pool: clear stranded `openai-codex` references after deleting the last real account and on startup, including stale membership left by external credential deletion.
- OpenAI Account Pool: recover email labels from both profile and root-level token claims; cover removal persistence and last-account cleanup through the production extension and Pi credential cache.
- Background Tasks: expose the approved non-polling startup guidance to direct and Codemode callers. Retain results after a user interrupt without restarting the agent, then hand them to the next user-message run; verify native tool batches, interrupts and compaction cancellation without changing Pi itself.
- Background Tasks: merge unread completions at the next safe tool boundary, consume pending reminders on terminal-output reads, and show actual completion times. Preserve automatic idle notification without adding a pause switch or changing Herdr execution/global queue settings.
- Background Tasks: reduce busy-session notification checks with exponential backoff capped at 30 seconds, without expiring unread results or delaying normal tool-boundary delivery.

- Herdr Subagents: show only Persona names and descriptions in model-facing selection lists, preserving diagnostics and detailed user-facing inspection.
- Make Agent Team user-invoked only through `/skill:agent-team`, hidden from automatic model selection.
- Add `npm run release:check -- vX.Y.Z` to wait for GitHub publication and verify exact npm versions, remote tags, integrity, and all tarball contents against the release commit, including coordinated child releases.

## 2026-10-21 - v0.13.1

- herdr-subagents v0.7.2: clarify final answer submission through subagent_report
- Herdr Subagents: clarify that child tasks must finish through `subagent_report`, not a normal text reply; remove the process-exit condition from the report instructions.

## 2026-10-20 - v0.13.0

- background-tasks v0.1.0: bundle background shell tasks with runtime limits, bounded logs, completion notifications and /bg controls
- Bundle and enable `@maxiaochao/pi-background-tasks` by default: managed shell jobs, Bash-aligned bounded output, completion followUps, `/bg` controls and an above-editor status widget. Keep the standalone package available as an alternative installation. The toolkit now requires Pi 1.3.0 or later.

## 2026-10-20 - v0.12.2

- herdr-subagents v0.7.1: clarify Persona responsibilities and dispatch guidance
- Clarify Herdr Persona selection and instructions: broad independent reviewer, codebase explorer, file-changing worker, and neutral charter-driven agent-team analyst. Make the Agent Team skill explicitly select analyst when dispatching through Personas.

## 2026-10-19 - v0.12.1

- herdr-subagents v0.7.0: add global and project default extension sources with Persona overrides
- Add Herdr Subagents `defaultExtensions` in global/project settings as a fallback below Persona-specific extension lists, with replacement semantics, explicit `[]` clearing, source diagnostics, and real child-loading coverage.

## 2026-10-15 - v0.12.0

- herdr-subagents v0.6.0: require explicit task Personas and clarify concise tool descriptions
- Require an explicit Herdr Subagents Persona for every new task, clarify concise tool descriptions, and identify tasks with conflicting write access in parallel requests.

## 2026-10-15 - v0.11.22

- herdr-subagents v0.5.4: preserve configured model and authentication extensions in isolated real-Herdr smoke tests
- Herdr Subagents: preserve configured models and explicit authentication extensions in isolated real-Herdr E2E tests instead of losing account-pool setup.

## 2026-10-15 - v0.11.21

- simplify Agent Team to config-driven orchestration with persistent investigation records and optional extra review

## 2026-10-14 - v0.11.20

- herdr-subagents v0.5.3: allow optional Pi-native tool exposure while inheriting Pi defaults when unset

## 2026-10-14 - v0.11.19

- herdr-subagents v0.5.2: stop Pi startup from scanning historical runs or closing recorded Herdr tabs

## 2026-10-14 - v0.11.18

- simplify global worktree isolation guidance

## 2026-10-14 - v0.11.17

- openai-account-pool v0.1.7: fix the session account marker after successful requests and failover

## 2026-10-14 - v0.11.16

- openai-account-pool v0.1.6: clarify deterministic priority and session account status

## 2026-10-14 - v0.11.15

- openai-account-pool v0.1.5: make the current-account marker session-local and hide it until the session uses Codex
- make the OpenAI Account Pool `●当前` marker session-local and hide it before the session uses Codex

## 2026-10-14 - v0.11.14

- herdr-subagents v0.5.1: fix focus-safe run cleanup and compact report output
- fix Herdr Subagents so completed child Pi panes remain inspectable while focused and close cleanly after focus leaves, without raw ANSI fragments from forced TUI exits
- keep large Subagent results on disk while showing compact report calls and one result path per task to the parent model

## 2026-10-14 - v0.11.13

- openai-account-pool v0.1.4: hide the redundant next-session marker when it matches the current account
- hide the redundant OpenAI Account Pool `★下次` marker when it matches `●当前`

## 2026-10-14 - v0.11.12

- scope release checks to changed packages and skip unchanged Herdr validation

## Unreleased

- Agent Team: make the main agent responsible for config-driven dispatch, result collection, and investigation records; use configured role charters as the single source of truth and make role rotation, extra replication, and open attack rounds optional.
- Keep release-routing test fixtures independent of changes since the latest root release tag.
- OpenAI Account Pool: restore `●本会话` after successful requests and failover across fresh command contexts; status and preference commands no longer reinstall the session provider.
- Scope child and root release checks to their owned code, and run Herdr tests or the real Agent smoke only when Herdr is the target or changed since the previous root release.
- OpenAI Account Pool: keep deterministic account priority and show it as `★首选`, separately from the session-local `●本会话` account; automatic mode uses account order rather than random selection.

## 2026-10-14 - v0.11.11

- openai-account-pool v0.1.3: defer account preference changes to new sessions for prompt-cache stability
- OpenAI Account Pool: apply `/codex_pool use` only to new sessions and subagents, preserving the current session's account for prompt-cache stability and labeling the global choice as `★下次` in status.

## 2026-10-14 - v0.11.10

- openai-account-pool v0.1.2: document that toolkit 0.11.9 was the last version to embed this package
- Stop enabling `openai-account-pool` in `pi install npm:@maxiaochao/pi-toolkit`: the toolkit tarball and default loadout no longer contain it, and its source stays an independently installable child package.
- Document which five child packages a toolkit install enables by default and which child stays a separate install. The toolkit README no longer describes Todo.

## 2026-10-14 - v0.11.9

- bundle openai-account-pool v0.1.1: publish the initial OpenAI Codex account pool and fix coordinated initial-release detection

## 2026-10-14 - v0.11.8

- bundle openai-account-pool v0.1.0: add OpenAI Codex account pooling with safe quota failover and live usage status
- bundle the OpenAI Account Pool package
- Add `@maxiaochao/pi-openai-account-pool` with `/codex_pool`, which pools several ChatGPT Plus/Pro logins behind `openai-codex` and continues a request on the next usable account when one proves it is out of quota.
- Let `node scripts/capture-package-media.mjs <slug>` regenerate media for selected packages, and render Chinese output with a CJK font.

## 2026-10-13 - v0.11.7

- bundle herdr-subagents v0.5.0: simplify lifecycle to one report-first state machine with strict serial and bounded read-only parallel execution

## 2026-10-13 - v0.11.6

- add a Why column to the child package table in README

## 2026-10-13 - v0.11.5

- bundle herdr-subagents v0.4.14: allow explicit extension sources with native Pi package semantics and reliable cleanup checks

## 2026-10-12 - v0.11.4

- bundle herdr-subagents v0.4.13: fix stale-idle child startup race and require real Herdr E2E release smoke

## 2026-10-12 - v0.11.3

- harden coordinated publishing and make local release checks authoritative

## Unreleased

- detect initial child-package releases from their coordinated changelog update so CI does not skip npm publication when `package.json` remains at its predeclared `0.1.0`

- Add opt-in Herdr Subagents persona extension sources, including npm/git Pi packages, with saved restart configuration and documented native package-resource semantics.
- Harden Herdr Subagents cleanup checks with condition-based waits, lock/focus regressions, and retained failure diagnostics; keep production cleanup behavior unchanged.
- Fix Herdr Subagents startup failures caused by stale idle observations and require real child-Agent smoke tests before releasing that package.

- Replace split child/root publishing with one idempotent root-tag workflow, make final-version local checks authoritative, keep CI publication-only, and remove timing-sensitive Herdr lifecycle assertions.

## 2026-10-12 - v0.11.2

- bundle herdr-subagents v0.4.12: enable codemode for child agents while preserving persona tool boundaries
- Enable `codemode` for bundled Herdr Subagents children while preserving persona tool boundaries.

## 2026-10-12 - v0.11.1

- bundle herdr-subagents v0.4.11: add architecture documentation and clear-output guidance evaluation

## 2026-10-12 - v0.11.0

- bundle worktree v0.4.0: Replace CLI start and prepare with the create-only command
- Replace `pi-worktree start` and `pi-worktree prepare` with the create-only `pi-worktree create` CLI; `/worktree start` and `enter_worktree` continue to switch the current Pi session.

## 2026-10-12 - v0.10.24

- bundle herdr-subagents v0.4.10: Stabilize concurrency checks and cancellation synchronization on slower CI runners.

## 2026-10-12 - v0.10.23

- bundle herdr-subagents v0.4.9: Stabilize concurrency checks on slower CI runners.

## 2026-10-12 - v0.10.22

- bundle herdr-subagents v0.4.8: make blocking behave identically in serial and parallel runs and let respond continue a named failed task from its saved session
- bundle Herdr Subagents runtime telemetry and concurrent historical-resume lifecycle fixes without conflating Herdr UI blocking with business blocking
- bundle Herdr Subagents failed-task continuation: answer a named failed task from its saved Pi session while its batch still runs, without closing shared tabs or restarting queued siblings
- bundle the Herdr Subagents three-outcome child contract (`completed`, `blocked`, `failed`): blocking now works identically in serial and parallel runs, keeps queued work with the batch that owns it, and always needs an explicit task number to answer

## 2026-10-10 - v0.10.21

- bundle herdr-subagents v0.4.7: fix blocked-run scheduling and limit interactive blocking to serial runs
- bundle the Herdr Subagents blocked-dispatch deadlock fix, serial-only interactive blocking, structured concurrent `missing_input` failures, and flexible run ID controls

## 2026-10-10 - v0.10.20

- bundle herdr-subagents v0.4.6: reduce global prompt noise by keeping Subagent workflow guidance in tool descriptions

## 2026-10-10 - v0.10.19

- bundle codex-edit v0.1.10: remove redundant apply_patch prompt metadata

## 2026-10-10 - v0.10.18

- allow models to invoke Agent Team autonomously for costly decisions and long evidence-chain investigations

## 2026-10-10 - v0.10.17

- bundle herdr-subagents v0.4.5: fix transient retry lifecycle, attempt isolation, and recovery semantics
- bundle Herdr Subagents lifecycle and attempt-isolation fixes so provider retries cannot create false failed tasks or overwrite newer attempts

## 2026-10-10 - v0.10.16

- tapd skill: handle large attachment timeouts without misdiagnosing download failures

## 2026-10-09 - v0.10.15

- redesign the TAPD skill around executable workflows, explicit workspace and JSON contracts, and safe attachment handling

## 2026-10-09 - v0.10.14

- bundle worktree v0.3.2: continue Agent tasks automatically after switching into a worktree

## 2026-10-09 - v0.10.13

- bundle worktree v0.3.1: show a persistent in-conversation confirmation after switching worktrees

## 2026-10-09 - v0.10.12

- bundle worktree v0.3.0: automatically move Agent conversations into prepared worktrees without external Harness support

## 2026-10-09 - v0.10.11

- bundle herdr-subagents v0.4.4: return failed foreground batches early while surviving subagents continue in background

## 2026-10-09 - v0.10.10

- require real Chrome frontend verification and remove the redundant chrome-cdp skill
- Require real Chrome click, screenshot, and behavior verification through `web-browser` for frontend feature development, and remove the redundant `chrome-cdp` skill.

## 2026-10-09 - v0.10.9

- bundle scheduler v0.1.1: add clear-all controls and multi-line widget coexistence

## 2026-10-09 - v0.10.8

- bundle worktree v0.2.0: add current-session worktree switching for users, Agents, and SDK Harnesses
- Improve Scheduler with clear-all controls and a visible above-editor row for every active schedule, separate from the below-editor Herdr Fleet.
- Bundle the Worktree Extension with `/worktree start`, the `enter_worktree` Agent Tool, and the structured Harness workspace-switch protocol.
- Add the idempotent `pi-worktree prepare --json` machine interface so the CLI remains the single implementation for worktree creation and reuse.

## 2026-10-09 - v0.10.7

- bundle scheduler v0.1.0: add session-scoped interval prompts with Agent and user controls
- Add the bundled and independently installable `@maxiaochao/pi-scheduler` package for session-scoped interval prompts, manual triggering, lightweight TUI status, and shared Agent/user controls.

## 2026-10-09 - v0.10.6

- bundle herdr-subagents v0.4.3: add per-run status, neutral analyst persona, and tool-agnostic Agent Team protocol
- Add per-run Herdr Subagents status queries so background review gates can inspect one run without polling the full history archive.
- Make Agent Team a tool-agnostic concurrent review protocol, decouple models from rotating methodological roles, and add a neutral read-only analyst persona.
- Remove Todo from the default toolkit bundle and loadout; users who want its progress UI can install `@maxiaochao/pi-todo` explicitly.

## 2026-10-08 - v0.10.5

- bundle herdr-subagents v0.4.2: add Alt+P and /parent controls to return from child Agents
## 2026-10-08 - v0.10.4

- bundle herdr-subagents v0.4.1: targeted cancellation, live token polling, and idempotent tab cleanup

## 2026-10-08 - v0.10.3

- bundle herdr-subagents v0.4.0: add the live compact Fleet footer with authoritative metrics and refreshed media
- Add the responsive below-editor Herdr Fleet monitor with real personas, task states, cumulative active durations, and authoritative child Pi token totals, including event-driven live updates and safe partial-JSONL handling.
- Color running Fleet rows yellow and completed rows green, compact the shared metrics column instead of pushing it to the terminal edge, and update the published media with focus restoration after capture.

## 2026-10-08 - v0.10.2

- bundle herdr-subagents v0.3.0: split execution and control tools and unify task runs
- Bundle the Herdr Subagents execution/control tool split and unified non-empty `tasks` input for single and multi-task runs.

## 2026-10-08 - v0.10.1

- bundle herdr-subagents v0.2.1: add default thinking configuration and inline Herdr workflow video
- remove the bundled `calldiff` skill
- add merged global/project `defaultThinking` for Herdr Subagents, below persona-specific thinking and above parent-session fallback
- embed the Herdr workflow video directly in the GitHub README, retain the reproducible WebM source, and remove the GIF preview
- document every Herdr Subagents settings and persona option, accepted values, defaults, configuration paths, examples, and exact precedence
- add a full real-time Herdr Subagents WebM recording that focuses every child Agent pane before returning to the parent summary

- replace the rendered Herdr transcript demo with a real UI recording of a parent Pi conversation opening and completing three concurrent interactive Agent panes

## 2026-10-08 - v0.10.0

- bundle herdr-subagents v0.2.0: replace Tiny Subagent with visible interactive Herdr agents and durable batch workflows
- replace Tiny Subagent's hidden print/shell execution with Herdr Subagents: visible interactive Pi Agents, one exclusive on-demand pane per task, Fleet keyboard navigation, durable blocked/history continuation, parent-session cancellation, and focus-safe batch tab cleanup
- fix Herdr Subagents Fleet state after blocked responses, preserve the active task widget while later background runs queue, and share ownership, pane-allocation, and status-reduction logic across recovery paths

## 2026-10-08 - v0.9.6

- bundle codex-edit v0.1.9: install the pinned Pi runtime for clean-runner publication tests
- install the pinned Pi test runtime on clean publication runners before executing Codex Edit integration checks

## 2026-10-08 - v0.9.5

- bundle codex-edit v0.1.8: fix repeated same-path updates and publish reproducible benchmark evidence
- harden bundled Codex Edit for repeated updates to one path and add mandatory native-vs-Codex and released-vs-local comparisons over a growing regression corpus
- generate and bundle the latest Codex Edit Markdown and self-contained HTML test report on every test run
- commit the completed 100-task benchmark evidence and make report generation deterministic on clean checkouts

## 2026-09-30 - v0.9.4

- retain Codex Edit in the root toolkit while restoring `@maxiaochao/pi-codex-edit` as an independently installable child package; both distributions share the implementation under `packages/codex-edit`
- align repeated-region hunk matching with Codex by selecting the first match at or after the current cursor
- reorganize the repository as an npm workspace: todo, cache-export, codex-edit, tiny-subagent, and worktree own their source, docs, tests, versions, and child-package releases while the root manifest loads their entrypoints directly; BTW remains root-only
- expand every child README with motivation or upstream alignment, usage examples, screenshots and animated demos captured from the real implementation; document Cache Export's alignment with Hugging Face Tau
- coordinate child and toolkit releases from one commit with two version updates, two tags, and one atomic push so standalone and bundled users cannot receive mismatched source revisions

## 2026-09-30 - v0.9.3

- refine global agent guidance and add repository issue, triage, and domain instructions

## 2026-09-30 - v0.9.2

- show contiguous queue positions in the todo widget while retaining stable internal task IDs

## 2026-09-30 - v0.9.1

- redesign the todo lifecycle with plan replacement, cancellation, automatic advancement, active-only widget rendering, concise model guidance, and deterministic state tests

## 2026-09-30 - v0.9.0

- merge the Codex-style apply_patch extension into the toolkit (from the standalone @maxiaochao/pi-codex-edit v0.1.6): it now ships as extensions/codex-edit/ registered in pi.extensions, its parser and model-routing tests join npm test, and the separate package, release script and publish workflow are removed

## 2026-09-24 - v0.8.2

- tapd skill: document the safe attachment-download flow for the short-lived signed URLs (re-fetch the URL for every attempt, download to .part with curl --fail --location --retry 3, reject text/error bodies before resuming, accept only 206 with a matching Content-Range, then verify size and zip integrity before renaming); it is a local addition on top of the `tapd skill init` output, recorded in AGENTS.md

## 2026-09-24 - v0.8.1

- lowercase the herdr skill name in its description and H1 (a deliberate local edit over the upstream v0.9.1 copy, now recorded in NOTICE, README and AGENTS.md); drop the stale `herdr --skill` pointer from the agent-team skill

## 2026-09-24 - v0.8.0

- add the agent-team skill: cross-vendor adversarial review in herdr panes, with the model roster in skills/agent-team/models.json

## 2026-09-24 - v0.7.2

- bundle the calldiff skill (copied verbatim from tanishqkancharla/calldiff, MIT, pinned to a main commit since upstream has no release tags) for call-stack diffs across git commits; the previous v0.7.1 tarball was briefly unavailable on the registry right after publish and is now served normally

## 2026-09-24 - v0.7.1

- bundle the herdr skill (copied verbatim from herdrdev/herdr v0.9.1, Apache-2.0) for driving the Herdr terminal multiplexer from inside a pane; move the tapd CLI skill from .claude/skills into skills/ so it ships with the package

## 2026-09-23 - v0.7.0

- bundle the pi-worktree skill documenting the CLI for agents (the isolation loop, and which commands need an interactive terminal); fix pi-worktree: the .gitignore check tested a path form that never matched the directory-only .worktrees/ pattern, so the rule was re-appended on the first run in every repo and that self-inflicted edit then triggered the uncommitted-changes prompt

## 2026-09-22 - v0.6.1

- bundle the pdlog skill for decompressing Pudu .pdlog logs (with bundled ppmd binary)

## 2026-09-22 - v0.6.0

- bundle the show-me skill for visual explanations (derived from humanlayer/skills, MIT), invoked explicitly with /skill:show-me

## 2026-09-15 - v0.5.3

- fix pi-worktree remove: worktrees with initialized submodules now remove via forced retry; dirty worktrees confirm the discard explicitly before removal; worktrees whose directory is already gone now prune their stale registration and clean up the branch

## 2026-09-11 - v0.5.2

- fix btw: side-session and summarize passed a nonexistent `modelRegistry` option to `createAgentSession`, so a fresh ModelRuntime was created that didn't know extension-registered providers (e.g. volcengine-plan) and prompting failed with "No API key found"; now the main session's ModelRuntime is reused via `modelRuntime`

## 2026-09-11 - v0.5.1

- fix pi-worktree: remove now cleans up the branch automatically — merged branches are deleted without prompting, unmerged ones confirm once (one prompt covers both worktree removal and branch deletion), so recreating the same name no longer silently reuses a stale branch

## 2026-09-11 - v0.5.0

- fix pi-worktree: new worktrees now branch from the current branch instead of a stale origin/main (worktree content no longer misses current work); add start --base <ref> to branch from an explicit ref

## 2026-09-11 - v0.4.0

- bundle the chrome-cdp skill for attaching to a live Chrome with remote debugging (derived from pasky/chrome-cdp-skill, MIT); pi-worktree: add explicit start subcommand and skip dirty-workspace prompt when reusing an existing worktree

## 2026-09-11 - v0.3.0

- add pi-worktree CLI: one-command worktree + Pi launch with list/info/out/remove/prune and bash completion (postinstall to ~/.local/bin)

## 2026-09-09 - v0.2.6

- fix cache export: segment-view tooltip and event markers now show global request numbers (aligned with the x-axis) instead of relative 1-based; e2e asserts real tooltip values

## 2026-09-09 - v0.2.5

- fix cache export: segment views lost the hover tooltip (it rendered inside the hidden all-history section); move to one page-level tooltip; e2e now asserts real rendering

## 2026-09-09 - v0.2.4

- fix cache export: hover tooltips now work across segment breaks; context segments also break on model changes; add headless-browser e2e tests

## 2026-09-08 - v0.2.3

- add cache export Context segment views

## 2026-09-03 - v0.2.2

- let the focused `/btw` overlay scroll its full transcript with Up/Down and PageUp/PageDown

## 2026-09-02 - v0.2.1

- update global agent instructions for harness-native file editing
- remove the HTML artifact output preference from the global instructions

## 2026-09-02 - v0.2.0

- bundle the Apache-2.0 `web-browser` skill for Chrome/Chromium CDP automation
- auto-detect Linux/macOS browsers and Windows Chrome when running under WSL
- include the skill's `ws` runtime dependency and document its release checks

## 2026-09-02 - v0.1.9

- add the `/btw` side-chat extension
- bundle the `nightowl` theme
- select `nightowl` during npm postinstall only when no theme is configured


- fix cache export branch attribution and update HTML artifact guidance

## 2026-08-21 - v0.1.7

- add the html-artifact skill for interactive HTML explanations and codebase visualizations
- register and package the skill for Pi discovery
- prefer `.cache/html/` for generated temporary HTML artifacts


- expand global agent guidance and reuse-before-writing rules

## 2026-08-18 - v0.1.5

- fix cache rebuild attribution and cache retention reporting

## 2026-08-18 - v0.1.4

- tbd

## 2026-08-18 - v0.1.3

- tbd

## 2026-08-18 - v0.1.2

- tbd

## 2026-08-18 - v0.1.1

- tbd

## Unreleased

- redesign bundled Todo as a branch-local execution plan with lifecycle-only model actions, expected-current guards, serialized calls, preserved branch history, and a live current-plan widget
- let `/cache_export` switch between all history and individual compaction-defined Context segments, defaulting to the latest segment; cache-hit cumulative lines reset at compaction or model boundaries
- add the independent `@maxiaochao/pi-codex-edit` package with model-aware Codex-style `apply_patch`
- include the benchmark summary and interactive HTML architecture explainer

## 2026-08-18 - v0.1.0

- initial release: todo extension + cache_export dashboard
