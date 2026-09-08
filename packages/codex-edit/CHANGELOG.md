## 2026-09-08 - v0.1.5

- route gpt-5.6-* models to apply_patch by model glob

## Unreleased

- route all `gpt-5.6-*` models to `apply_patch` regardless of provider
- route by model-ID glob instead of provider/model pairs

## 2026-09-04 - v0.1.4

- update Luna High rerun statistics and paired timing methodology

## 2026-09-04 - v0.1.3

- correct Luna timing analysis to count only completed correct runs

## 2026-09-04 - v0.1.2

- default to validated Sol routing and document Luna High benchmark variance

## 2026-09-04 - v0.1.1

- fix package config discovery so GPT/Codex model routing activates apply_patch

## 2026-09-04 - v0.1.0

- initial release of the Codex-style apply_patch Pi extension and docs

## 2026-09-04 - v0.1.0

- initial release of the model-aware Codex-style `apply_patch` Pi extension
- keep Pi's native `edit` tool active for non-grammar models
- include the benchmark summary and interactive HTML architecture explainer
