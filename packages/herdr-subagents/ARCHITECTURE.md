# Herdr Subagents architecture

## Goal

Herdr owns terminal presentation and pane operations. The package owns scheduling and durable state. Pi children own only their attempt result.

## State machines

Task:

```
queued -> running -> completed
                  -> failed
                  -> cancelled
```

The three terminal states are immutable. Follow-up work creates a new task or run.

Run:

```
running -> completed | failed | partial | cancelled
```

Run state is derived from task state. `partial` means terminal tasks have mixed outcomes.

Legacy readers still accept old `starting` and `blocked` values so existing archives can be inspected and cleaned up. New execution does not produce them.

## Scheduling

A run uses a bounded worker pool:

1. Tasks begin FIFO.
2. With concurrency one, the next task cannot start until the previous task is terminal.
3. With concurrency N, at most N tasks own live child processes.
4. Failure consumes only that task's lane; queued siblings continue.
5. Parallel execution is rejected if any task is write-capable.
6. The caller remains attached until all tasks are terminal or the caller cancels.

There is no global dispatcher, persisted background queue, blocked response lane, historical resume, or early detach.

## Child boundary

Each task owns one Herdr pane and one single-task Pi process. Herdr first starts and detects the interactive Pi, then submits the prompt exactly once. The child extension exits the process at Pi’s final `agent_settled` boundary, giving each task an unambiguous process lifetime without parent-side prompt retries.

The child writes:

- `results/<attempt-id>.md`
- `reports/<attempt-id>.json`

Both are attempt-scoped. The report is published with atomic rename. The orchestrator validates it, verifies the attempt identity, and promotes it to `report.json`.

The orchestrator writes:

- `task.json`
- `run.json`
- promoted `report.json`

## Completion arbitration

1. Check for a valid attempt report.
2. If present, the report wins, including against a concurrent cancellation observation.
3. Otherwise inspect child process liveness.
4. While the process is alive, keep waiting. Herdr agent states only wake reconciliation.
5. If the process has exited, check disk once more and fail only when no report exists.

There is no fixed drain delay and no transcript parsing. Pi retries are internal to the same one-shot process, so transient provider or transport errors cannot create a premature terminal task.

Writing the same report again is idempotent. A conflicting replacement is rejected.

## Cancellation and recovery

Caller or parent-session cancellation aborts active waits, marks nonterminal tasks cancelled, and closes the owned Herdr tab. Startup recovery is scoped by recorded parent ownership and retains readers for prior record formats. Recovery never resumes or mutates an already terminal task.
