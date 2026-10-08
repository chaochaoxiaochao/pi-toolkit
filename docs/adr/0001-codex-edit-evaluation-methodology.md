---
status: accepted
---

# Evaluate Codex Edit with agent, protocol, and safety evidence

Codex Edit releases use three separate evidence layers because parser fixtures cannot establish model-level editing quality and model benchmarks do not reliably trigger rare protocol defects. The release gate compares native Pi edit, the npm `latest` Codex Edit resolved and pinned at run start, and the local working tree on one frozen 100-task Explicit Edit manifest: 80 proportionally sampled neutral tasks plus 20 declared challenge tasks, all using `openai-codex/gpt-5.6-sol` at low reasoning with up to five Oracle recoveries. Score v2, First Exact, Final Exact, paired outcomes, efficiency, cost, and tool use remain distinct; deterministic Protocol Regressions prove reported fixes, while Safety Regressions require rejection with zero mutation and never count as failed editing tasks.

## Consequences

The local arm must score strictly above native edit, must not materially regress from the pinned released arm, and may pass with at most two documented paired regressions when improvements are at least as numerous. Agent results become invalid when confirmed provider failures exceed 5%; selective task reruns are forbidden. Every run generates one summary, a complete Markdown report, and a self-contained HTML report from the same committed, sanitized evidence. The upstream benchmark source, task hashes, package version and integrity, runtime versions, model route, reasoning level, recovery policy, and predeclared scheduling-stop and hard budget limits are recorded so later releases can reproduce the decision. A budget-stopped prefix remains incomplete regardless of its observed score; a release claim requires all 300 chains.
