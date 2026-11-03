---
name: pi-worktree
description: Create, enter, inspect, and clean up git worktrees through the enter_worktree tool, /worktree command, or pi-worktree CLI. Use when a task warrants isolation in its own worktree, or when the user asks to handle something the worktree way.
---

# pi-worktree

New worktrees live in the main checkout’s `.worktrees/<name>` (added to `.gitignore`), each with a branch of the same name, branched from the current branch (or `HEAD` when detached). Creation also works from a linked worktree; new branches use that checkout’s HEAD, and uncommitted changes stay there. Existing branches are attached without resetting them. The base commit is recorded in `branch.<name>.base` / `branch.<name>.baseRef` so `info` can report where the branch came from.

Installed by the package postinstall hook to `~/.local/bin/pi-worktree`, with bash completion for subcommands and existing worktree names.

## Commands

| Command | Effect |
|---|---|
| `enter_worktree({ name, base? })` | Agent entrypoint: create/reuse a worktree and automatically move this conversation there after the run settles. Call it alone. Stop if `switch` is `scheduled`; continue in the current session if `already-active`. |
| `/worktree start <name> [--base <ref>]` | User entrypoint: fork the current persistent session into the worktree and switch the current Pi UI. |
| `pi-worktree create [--base <ref>] [--json] <name>` | Idempotently create/reuse without launching Pi; `--json` is the machine interface. |
| `pi-worktree list` | All worktrees; the main checkout is marked `(main checkout)`, stale registrations are flagged. |
| `pi-worktree info <name>` | Clean/dirty status, branch and HEAD, base commit, ahead/behind `main`, unique commits. |
| `pi-worktree out` | Open a shell in the main checkout (for merging). |
| `pi-worktree remove [--force] <name> [<name> ...]` | Resolve actual registered paths by branch name, including external paths and slash-named branches, then remove in order; asks before discarding dirty files or commits not merged into local `main`. Stops on failure without undoing earlier removals. |
| `pi-worktree prune` | Drop registrations whose directory was deleted by hand. |

## Isolating a task

1. **Survey** — `pi-worktree list`, plus `pi-worktree info <name>` when the name you want is already taken. Reuse is free; a removed worktree is gone for good, because `remove` deletes its branch.
2. **Enter** — as an Agent, call `enter_worktree` once. If scheduled, stop; the Extension switches automatically after settlement. If already active, continue without a session fork. A user can instead run `/worktree start <name>`.
3. **Work** — inside the worktree: commit there, and check `pi-worktree info <name>` before claiming progress. `ahead: N commits since base` is the evidence.
4. **Land** — `pi-worktree out`, then `git merge <name>` in the main checkout. Done when the worktree's unique commits are in the target branch.
5. **Clean up** — `pi-worktree remove <name>`. A branch merged into local `main` goes without prompting; otherwise deletion asks for confirmation. Main, current and locked worktrees are protected.

## Entry-point rules

- Prefer `enter_worktree` when it is available. If `switch` is `scheduled`, wait for the Extension to fork and switch after `agent_settled` before doing repository work. If `already-active`, continue directly in the same session.
- `/worktree` is user-facing and cannot be invoked by the model. It requires a persisted session because it forks history into a session whose header owns the worktree cwd. The source session stays on disk; subsequent messages go only to the fork.
- `create` is idempotent and never launches Pi. It reports whether the target was created, attached, reused, or already active, and reports dirty reuse rather than discarding anything.
- `remove` asks before discarding dirty files or unmerged commits, and a non-interactive stdin (EOF) aborts safely unless `--force`/`-f` was supplied. Use force only with explicit authorization to discard dirty files and unmerged commits; protected worktrees still cannot be removed. Answer explicitly when the removal is intended: `printf 'y\ny\n' | pi-worktree remove <name>`.
