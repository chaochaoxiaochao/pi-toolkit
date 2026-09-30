# GPT-5.6 Edit Benchmark Final Report

Generated: 2026-09-04

## Isolation

All Pi runs used no-context-files, a temporary PI_CODING_AGENT_DIR, a dedicated session directory, fresh temporary workspaces, and no ambient extensions. The global /home/maxiaochao/.pi/agent/AGENTS.md was not loaded. The fair comparison gave both arms read, bash, and write; only the editor tool differed.

## Main comparison

| Metric | A current edit | C production apply_patch | Difference |
|---|---:|---:|---:|
| Fixed fixtures | 20 | 20 | same |
| Final exact correctness | 18/20 (90%) | 18/20 (90%) | 0 points |
| First editor success | 85% | 95% | +10 points |
| Median editor calls | 1 | 1 | same |
| Median recovery editor calls | 0 | 0 | same |
| Median agent turns | 4 | 4 | same |
| Median input+output tokens | 9732 | 9978 | +2.5% |
| Median all tokens including cache | 26722 | 26503 | -0.8% |
| Median duration | 17.75s | 16.95s | -4.5% |
| Protocol failures | 1 | 0 | improved |
| Context files loaded | 0 | 0 | valid |

A/B prompt exploration with the restricted read+edit tool set produced 75% final correctness for both current and neutral prompt arms. That result is not used as the main decision because it excluded the real Pi write and bash tools. It is useful only as evidence that the current edit contract cannot express add/delete/move operations by itself.

## What apply_patch improved

- GPT-5.6 emitted valid first-pass custom-tool calls in 19 of 20 fair cases; the remaining case used another available tool instead of apply_patch.
- The production route eliminated the observed editor protocol failure in the fair set.
- The Codex protocol naturally handles add, delete, update, and move in one patch, but the fair baseline could often complete those tasks through write/bash, so final correctness did not improve.
- Custom Lark tool encoding was verified through persisted apply_patch calls with ctc_ identifiers.

## What it did not improve

- Exact final correctness remained 90% for both arms.
- Median editor calls and agent turns were unchanged.
- Input/output tokens were slightly higher; cache-inclusive token totals were effectively unchanged.
- Median duration improved only 4.5%, below the 15% production threshold.
- Codex CLI could not serve as a reference arm because the proxy returned HTTP 401 even when retried with the Pi-configured key.

## Dynamic routing

The production extension route probe passed:

- GPT-5.6 Sol: active tools included read and apply_patch, with grammar capability true.
- DeepSeek V4 Flash: active tools included read and edit, with grammar capability false.
- The unrelated active tools were preserved and no extension errors occurred after fixing the settings closure bug.

The probe conditions above reflect v0.1.5, when the route still required grammar capability. Since v0.1.6 the route is `model.api` plus the model-ID allowlist only; a provider without grammar tools falls back to a normal function tool.

## Decision

No-go for universal enablement in the original benchmark environment. The evidence did not justify routing every model through `apply_patch` or making it the default editor for the whole Pi workflow. The shipped route is therefore a model-ID allowlist (`gpt-5.6-*` plus an `openai-responses`/`openai-codex-responses` API check) that keeps `edit` as the fallback everywhere else. The implementation now ships inside `@maxiaochao/pi-toolkit` instead of as a standalone opt-in package, but the allowlist — not the packaging — is what bounds the change: for a non-allowlisted model the extension only re-syncs an already-active editor tool and otherwise returns early.

The production route was validated with `pudu-openai-proxy/gpt-5.6-sol:high` and `pudu-openai-proxy/gpt-5.6-luna:high`. Sol's 20-case fair run improved first editor-call success from 85% to 95% with equal final correctness. A corrected Luna rerun used the fully qualified `pudu-openai-proxy/gpt-5.6-luna:high` in both arms, with 20/20 normally completed runs in each arm: both reached 18/20 final correctness, while first editor-call success was 18/20 for `edit` and 20/20 for `apply_patch`. Among the 17 cases correct in both arms, the paired median total-duration delta was +2.3s for `apply_patch`, with 8 cases faster and 9 slower; across all 20 paired runs, the median delta was +1.2s, with 9 cases faster and 11 slower. The measured tradeoff justified validating Sol first; the shipped `gpt-5.6-*` glob additionally enables Luna and Terra, whose gap is protocol adaptation rather than a stable duration win.
