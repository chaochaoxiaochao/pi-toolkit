# Testing Pi OpenAI Account Pool

Run from the repository root:

```bash
npm --prefix packages/openai-account-pool test
npm --prefix packages/openai-account-pool run load-test
npm pack ./packages/openai-account-pool --dry-run
```

Every test runs against an isolated temporary agent directory with fixture credentials. No real token, refresh token or authorization callback URL appears in this repository, in the tests, or in the generated media.

- `tests/store-ownership.mjs` covers the credential store: unrelated provider entries survive, the lock is mutually exclusive with pi's own writes in both directions, cancelled lock waits, stale lock reclaim, a compromised lock refusing to write, single token rotation under concurrency, ownership across plain login/logout/re-enable, monotonic generations, corrupt JSON and symlink refusal, and enrollment lease recovery.
- `tests/selection.mjs` covers classification and selection: only structured `usage_limit_reached` counts as a subscription limit, a plain 429 with the same friendly wording does not, reset times are validated, and shared state ignores stale generations and late successes.
- `tests/command-completions.mjs` covers slash-command argument completion, including the real TUI regression where returning an identical completion for a fully typed `status` consumed the first Enter instead of submitting the command.
- `tests/enrollment.mjs` covers the `/codex_pool` loop: repeated continue adds more than two accounts, an existing plain login is migrated instead of replaced, ending immediately changes nothing, failures are redacted, cancelling keeps what was already saved, two processes cannot enroll at once, and status/off/remove speak in masked labels.
- `tests/usage.mjs` covers live `wham/usage` normalization and headers, OAuth refresh, sequential account queries, bounded response size and time, non-secret failures, stale-observation races, cross-process probe leases, model-scoped recovery estimates, stored exhaustion after a failed live lookup, and the immediately rendered colored status widget with loading state and line-final `●本会话`. Every HTTP path uses an injected fixture transport.
- `tests/failover-stream.mjs` runs through real pi-ai stream plumbing: one external start, no replay after output, a repaired 401, websocket-style evidence, cancellation, session-scoped preference sampling, one live-usage sweep when all accounts are locally unavailable, recovered-account selection, and exhausted-pool earliest-ready messages.
- `tests/multiprocess.mjs` spawns real child processes: two pi processes racing an expired rotating refresh token exchange it exactly once and converge on the same credential, concurrent writes from five processes lose no entry, and a valid credential is never refreshed.
- `tests/integration-login-ownership.mjs` uses the real `Models` implementation to show that a second plain login still overwrites the first, and that the pool keeps every account.

For a manual check, run pi with `-e ./packages/openai-account-pool/extensions/openai-account-pool.ts`, run `/codex_pool`, authorize two different ChatGPT accounts, and confirm that the same model keeps answering after the first account reports its limit. Do not exhaust a paid quota on purpose; record what was and was not executed.

Regenerate package media with:

```bash
node scripts/capture-package-media.mjs openai-account-pool
```
