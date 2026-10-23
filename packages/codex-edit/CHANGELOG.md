## Unreleased

- Reject file/ancestor target conflicts before any patch writes, regardless of operation order.
- Preserve ordinary source permission bits on Move, including executable bits and permissions masked by umask.
- Add real-filesystem cases to the shared corpus. Keep the frozen parser baseline unchanged and mark filesystem-only baseline comparisons unsupported.
- Keep expected-failure assertions outside exception handlers so unexpected success cannot pass as rejection.

## 2026-10-21 - v0.2.0

- persist personal routing rules in the Pi agent directory across package updates
- Read persistent user overrides from `~/.pi/agent/codex-edit.json`, or the custom `PI_CODING_AGENT_DIR`, so package updates no longer replace personal routing rules.
- Merge settings by field over package defaults; replace model lists, preserve explicit false/empty values, and report malformed or unreadable configuration with its path.
- Cover shared parent/child editor routing, reloads, API restrictions, read-only tool selection, and real patch execution through the production extension factory.

## 2026-10-10 - v0.1.10

- remove redundant apply_patch prompt metadata

## 2026-10-08 - v0.1.9

- install the pinned Pi runtime for clean-runner publication tests
- install the pinned Pi test runtime on clean publication runners before executing native comparison and extension-load checks

## 2026-10-08 - v0.1.8

- fix repeated same-path updates and publish reproducible benchmark evidence
- apply repeated plain `Update File` blocks for one path in order while retaining conflict rejection for add/delete/move targets
- expand regressions and testing policy for repeated regions, empty chunks, stale context, malformed arguments, and project-scale patches
- add mandatory real-native-edit versus local and released-v0.1.7 versus local comparisons over one growing scenario corpus
- generate a Markdown test report and self-contained HTML report on every package test run
- interleave the frozen Neutral/Challenge schedule at 4:1 and add five production-incident regression entries so budget-limited prefixes still exercise reported failure shapes
- complete the frozen 100-task three-arm benchmark and commit sanitized evidence so clean checkouts reproduce the reports without local cache data

## 2026-09-30 - v0.1.7

- match Codex `apply_patch` semantics by selecting the first matching region at or after the current hunk cursor
- add standalone package testing documentation and real parser-generated screenshot/demo media

## 2026-09-30 - v0.1.6

- route apply_patch by API plus model-ID glob instead of requiring grammar-tool support

## 2026-09-08 - v0.1.5

- route gpt-5.6-* models to apply_patch by model glob

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
