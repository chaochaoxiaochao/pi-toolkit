# Herdr Subagents

Run focused Pi subagents in visible, focusable Herdr panes and collect exactly one terminal result per task.

The implementation is intentionally small: one task state machine, one derived run state, and one bounded worker pool. Herdr provides visible panes and navigation; the package only dispatches serial or read-only parallel work, waits for a report, and records the result. It does not add a second workflow engine around Pi.

![Herdr Subagents running as visible panes](docs/screenshot.png)

## Demo

https://github.com/user-attachments/assets/8ddf3ae6-a11a-492b-9cae-d9496ba65b67

The reproducible source recording is retained as [`docs/demo.webm`](docs/demo.webm).

## Execution contract

`herdr_subagents` accepts an ordered, non-empty `tasks` array.

- `concurrency: 1` runs tasks strictly in input order.
- `concurrency: N` runs at most N read-only tasks at once.
- A run containing a write-capable persona must use `concurrency: 1`; unsafe parallel writes are rejected.
- One task failing does not cancel its siblings.
- The tool returns only after every task is `completed`, `failed`, or `cancelled`.
- There is no background queue, blocked/respond flow, automatic resume, or early failure detach.

```json
{
  "label": "review",
  "concurrency": 2,
  "tasks": [
    { "name": "api", "prompt": "Review the API boundary.", "agent": "reviewer" },
    { "name": "tests", "prompt": "Find missing test coverage.", "agent": "explorer" }
  ]
}
```

Each task starts a single-task interactive Pi process in its own Herdr pane. Herdr first confirms the interactive Pi is ready, then the prompt is delivered exactly once. Prompt acknowledgement never decides task completion. Panes remain ordinary Herdr panes: they can be focused and inspected while work is running.

## Result protocol

The child must call `subagent_report` once with a terminal status:

- `completed`: the requested work finished.
- `failed`: it cannot be completed; include `error`.

The complete result is stored on disk. The parent receives only the compact summary and document paths.

An atomically renamed attempt report is the authoritative completion signal. Herdr states such as `idle`, `blocked`, and `done` are wake-up hints only. A prompt transport error or Pi retry cannot fail a task while its child process remains alive. If the process exits without a valid report, the task fails explicitly.

Duplicate identical reports are idempotent. A conflicting report for the same task attempt is rejected. Terminal task records are immutable.

## State model

The same small state machine is used for every task; there are no separate foreground, background, blocked, resumed, or retry lifecycles.

New task records use:

```
queued -> running -> completed | failed | cancelled
```

A run is `running` while any task is queued or running. Settled aggregate states are `completed`, `failed`, `partial`, or `cancelled`.

Older records containing `starting` or `blocked` remain readable for history and cleanup, but new runs never write those states.

## Durable records

Records are stored under:

```
.pi/herdr-subagents/runs/<sortable-run-id>/
  run.json
  tasks/<order>-<task-id>/
    task.json
    session.jsonl
    system-prompt.md
    report.json
    reports/<attempt-id>.json
    results/<attempt-id>.md
```

The orchestrator is the only writer of `run.json`, `task.json`, and promoted `report.json`. The child only writes its attempt-scoped result and report.

## Control and UI

`herdr_subagents_control` supports `list`, `status`, `history`, `cancel`, and `cleanup`. Follow-up work is a new task or run; settled tasks are never revived.

Use `/herdr-subagents focus <task-number>` to focus a running pane. `/herdr-subagents active`, `history`, `agents`, `models`, and `settings` provide compact inspection.

## Personas and settings

Bundled personas are `worker`, `explorer`, `analyst`, and `reviewer`. Project personas can be added under `.pi/agents/` using the same frontmatter format as the bundled files. Access is declared as `read` or `write` and drives concurrency safety.

Settings are read from the existing package configuration. `defaultConcurrency`, `maxConcurrency`, and `stalledWarningSeconds` remain supported.
