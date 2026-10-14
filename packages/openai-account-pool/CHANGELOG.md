## Unreleased

- Make `●当前` session-local: hide it until this Pi session successfully uses a pooled Codex account instead of showing another session's global history.

## 2026-10-14 - v0.1.4

- hide the redundant next-session marker when it matches the current account
- Hide the redundant `★下次` status marker when the next-session preference is already the current account.

## 2026-10-14 - v0.1.3

- defer account preference changes to new sessions for prompt-cache stability
- Make `/codex_pool use` a global next-session preference: existing sessions keep their sampled account for prompt-cache stability, new sessions and subagents read the updated choice, and status marks it as `★下次` separately from `●当前`.

## 2026-10-14 - v0.1.2

- document that toolkit 0.11.9 was the last version to embed this package
- Add the toolkit compatibility statement to Install, and limit the double-registration warning to toolkit 0.11.9 and earlier, which were the last versions to embed this package.

## 2026-10-14 - v0.1.1

- publish the initial OpenAI Codex account pool and fix coordinated initial-release detection

## 2026-10-14 - v0.1.0

- add OpenAI Codex account pooling with safe quota failover and live usage status
- add multi-account failover for the openai-codex provider
- Add `/codex_pool` with a continue/end loop that adds any number of ChatGPT accounts through the native OAuth flow and keeps an existing single login.
- Switch accounts on proven subscription limits or proven authorization failures only, before any output reaches the conversation.
- Share cooldown and probe state between pi processes in the same agent directory, and keep auth.json authoritative for credentials.
- Show live per-account Codex usage and the last successful account, recover locally cooled accounts with one bounded usage sweep, and report the earliest server-stated recovery time.
- Keep usage recovery race-safe across processes with freshness-guarded state updates, probe leases, bounded private-endpoint reads, model-scoped estimates, and non-secret failure codes.
- Show `/codex_pool status` in a temporary colored panel above the editor that appears immediately, displays cached state, refreshes live quota in the background, and removes itself after 15 seconds; keep non-TUI text output and place `●当前` at the end of the account line.
- Stop returning an identical argument completion after a subcommand is fully typed, so one Enter submits `/codex_pool status` instead of merely accepting `status`.
