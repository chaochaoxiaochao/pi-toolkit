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

- let `/cache_export` switch between all history and individual compaction-defined Context segments, defaulting to the latest segment; cache-hit cumulative lines reset at compaction or model boundaries
- add the independent `@maxiaochao/pi-codex-edit` package with model-aware Codex-style `apply_patch`
- include the benchmark summary and interactive HTML architecture explainer

## 2026-08-18 - v0.1.0

- initial release: todo extension + cache_export dashboard
