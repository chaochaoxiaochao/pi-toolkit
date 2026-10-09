## Unreleased

- Bundle the Worktree Extension with `/worktree start`, the `enter_worktree` Agent Tool, and the structured Harness workspace-switch protocol.
- Add the idempotent `pi-worktree prepare --json` machine interface so the CLI remains the single implementation for worktree creation and reuse.

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
