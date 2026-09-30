---
name: pi-worktree
description: Create, inspect, and clean up git worktrees with the pi-worktree CLI (start/list/info/remove/prune), which also launches Pi inside the worktree. Use when a task warrants isolation in its own worktree, or when the user asks to handle something the worktree way.
---

# pi-worktree

`pi-worktree` wraps git worktree creation and Pi launch into one command. Worktrees live in `.worktrees/<name>` (added to `.gitignore`), each with a branch of the same name, branched from the branch you are on now (or `HEAD` when detached). The base commit is recorded in `branch.<name>.base` / `branch.<name>.baseRef` so `info` can always report where the branch came from.

Installed by the package postinstall hook to `~/.local/bin/pi-worktree`, with bash completion for subcommands and existing worktree names.

## Commands

| Command | Effect |
|---|---|
| `pi-worktree start <name> [pi args...]` | Create or reuse `.worktrees/<name>`, then launch Pi inside it. Already inside a linked worktree, it just launches Pi there. |
| `pi-worktree start --base <ref> <name> [pi args...]` | Same, but branch from `<ref>` instead of the current branch. |
| `pi-worktree list` | All worktrees; the main checkout is marked `(main checkout)`, stale registrations are flagged. |
| `pi-worktree info <name>` | Clean/dirty status, branch and HEAD, base commit, ahead/behind `main`, unique commits. |
| `pi-worktree out` | Open a shell in the main checkout (for merging). |
| `pi-worktree remove <name>` | Remove the worktree and its branch; asks before discarding dirty files or unmerged commits. |
| `pi-worktree prune` | Drop registrations whose directory was deleted by hand. |

## Isolating a task

1. **Survey** — `pi-worktree list`, plus `pi-worktree info <name>` when the name you want is already taken. Reuse is free; a removed worktree is gone for good, because `remove` deletes its branch.
2. **Start** — `pi-worktree start <name>` (with `--base <ref>` when the work must not start from the current branch). Done when `list` shows the new worktree on its own branch.
3. **Work** — inside the worktree: commit there, and check `pi-worktree info <name>` before claiming progress. `ahead: N commits since base` is the evidence.
4. **Land** — `pi-worktree out`, then `git merge <name>` in the main checkout. Done when the worktree's unique commits are in the target branch.
5. **Clean up** — `pi-worktree remove <name>`. A merged branch goes without prompting; anything unmerged asks once.

## Driving it from an agent

- `start` **execs `pi`** in the worktree, and `out` execs a shell. With no trailing Pi args both want an interactive terminal, so either run `start <name> -p "<task>"` for a headless nested run, or hand the bare `start <name>` to the user to run themselves.
- `remove` asks before discarding dirty files or unmerged commits, and a non-interactive stdin (EOF) aborts safely. Answer explicitly when the removal is intended: `printf 'y\ny\n' | pi-worktree remove <name>`.
- Your own working directory cannot change. "Isolate this in a worktree" therefore means launching a nested headless Pi in the worktree, or telling the user to run `pi-worktree start <name>`.
