---
name: pi-worktree
description: Create, enter, inspect, and clean up git worktrees through the enter_worktree tool, /worktree command, or pi-worktree CLI. Use when a task warrants isolation in its own worktree, or when the user asks to handle something the worktree way.
---

# pi-worktree

Worktrees live in `.worktrees/<name>` (added to `.gitignore`), each with a branch of the same name, branched from the current branch (or `HEAD` when detached). The base commit is recorded in `branch.<name>.base` / `branch.<name>.baseRef` so `info` can report where the branch came from.

Installed by the package postinstall hook to `~/.local/bin/pi-worktree`, with bash completion for subcommands and existing worktree names.

## Commands

| Command | Effect |
|---|---|
| `enter_worktree({ name, base? })` | Agent entrypoint: create/reuse a worktree and automatically move this conversation there after the run settles. Call it alone and stop after it returns. |
| `/worktree start <name> [--base <ref>]` | User entrypoint: fork the current persistent session into the worktree and switch the current Pi UI. |
| `pi-worktree prepare [--base <ref>] [--json] <name>` | Create/reuse without launching Pi; `--json` is the machine interface. |
| `pi-worktree start <name> [pi args...]` | Create or reuse `.worktrees/<name>`, then launch Pi inside it. Already inside a linked worktree, it just launches Pi there. |
| `pi-worktree start --base <ref> <name> [pi args...]` | Same, but branch from `<ref>` instead of the current branch. |
| `pi-worktree list` | All worktrees; the main checkout is marked `(main checkout)`, stale registrations are flagged. |
| `pi-worktree info <name>` | Clean/dirty status, branch and HEAD, base commit, ahead/behind `main`, unique commits. |
| `pi-worktree out` | Open a shell in the main checkout (for merging). |
| `pi-worktree remove <name>` | Remove the worktree and its branch; asks before discarding dirty files or unmerged commits. |
| `pi-worktree prune` | Drop registrations whose directory was deleted by hand. |

## Isolating a task

1. **Survey** — `pi-worktree list`, plus `pi-worktree info <name>` when the name you want is already taken. Reuse is free; a removed worktree is gone for good, because `remove` deletes its branch.
2. **Enter** — as an Agent, call `enter_worktree` once and stop; the Extension switches automatically after settlement. A user can instead run `/worktree start <name>`. Use the CLI `start` only when a separate Pi process is wanted.
3. **Work** — inside the worktree: commit there, and check `pi-worktree info <name>` before claiming progress. `ahead: N commits since base` is the evidence.
4. **Land** — `pi-worktree out`, then `git merge <name>` in the main checkout. Done when the worktree's unique commits are in the target branch.
5. **Clean up** — `pi-worktree remove <name>`. A merged branch goes without prompting; anything unmerged asks once.

## Entry-point rules

- Prefer `enter_worktree` when it is available. After the tool returns, do not read or modify repository files; the Extension waits for `agent_settled`, then forks the session into the target cwd and switches automatically.
- `/worktree` is user-facing and cannot be invoked by the model. It requires a persisted session because it forks history into a session whose header owns the worktree cwd.
- `pi-worktree start` **execs a new `pi`** in the worktree, and `out` execs a shell. Use this only for an intentionally separate process/session.
- `prepare` is idempotent. It reports whether the target was created, attached, reused, or already active, and reports dirty reuse rather than discarding anything.
- `remove` asks before discarding dirty files or unmerged commits, and a non-interactive stdin (EOF) aborts safely. Answer explicitly when the removal is intended: `printf 'y\ny\n' | pi-worktree remove <name>`.
