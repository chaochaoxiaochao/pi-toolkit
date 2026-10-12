# AGENTS.md Clear Output Evaluation

This A/B evaluation measures the effect of the `Clear Output` guidance. The `before` variant uses a minimal coding-assistant prompt. The `after` variant adds only the two `Clear Output` rules.

Run the deterministic scorer tests:

```bash
npm run eval:agents:test
```

Run the model evaluation:

```bash
npm run eval:agents -- --runs 2
```

Set `PI_EVAL_MODEL` or pass `--model <provider/model>` to pin a model. Results are written to `results/latest.json` and `results/latest.md`.

The scorer measures sentence length, conjunction density, response language, terminology changes, and use of a visual for the branching-flow case. These are proxies. Review the saved outputs for correctness and completeness before accepting a prompt change.
