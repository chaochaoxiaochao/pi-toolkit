# Pi Background Tasks

Run shell commands in the background, then notify the main agent when they finish. These are local processes, not subagents.

![Two real background jobs beside Scheduler](docs/screenshot.png)

![Real Pi: start, cancel, completion and output](docs/demo.gif)

## Why

A command such as `sleep 60; python3 ...` can spend most of its time waiting to check a build log. A normal Bash call keeps waiting for that command. This package returns a task ID immediately so the main agent can do other work.

It uses Pi's public `createLocalBashOperations()` backend for shell execution and process-group cancellation. It adds session ownership, bounded logs, status, and completion messages. It neither replaces Bash nor starts another model or Herdr pane.

## Install and update

Requires Pi **1.3.0 or later**.

```bash
pi install npm:@maxiaochao/pi-background-tasks
pi update npm:@maxiaochao/pi-background-tasks
```

The complete `@maxiaochao/pi-toolkit` package **bundles and enables Background Tasks by default**. Choose either the toolkit or this standalone package; do not install both, because the tool and `/bg` command would be registered twice.

## Agent tool

```text
background_task({ action: "start", command: "sleep 10; printf 'checks complete\\n'", description: "Delayed check", timeout: 120 })
background_task({ action: "list" })
background_task({ action: "output", id: "<returned-task-id>" })
background_task({ action: "cancel", id: "<returned-task-id>" })
```

Start returns a running task's ID, log path and runtime limit, not the command's final output. An invalid start is rejected before execution. A later execution error becomes a failed task.

- `command`: unchanged multi-line shell script; only for start.
- `description`: optional display label, shortened to 200 characters.
- `cwd`: optional directory, resolved relative to the current session directory.
- `timeout`: integer seconds, **1800 by default**, from 1 through 7200. Zero and unlimited mode are rejected.
- `id`: required for output and cancel. IDs belong only to their originating session.

At most **two** tasks run at once. A third request fails immediately; it is not queued. Cancelling waits for process cleanup. Cancelling an already-ended task returns its status without another completion notification.

List shows running tasks and the latest 20 finished tasks, with total and omitted counts. Older logs remain queryable by their IDs until the session closes.

## User controls and status

```text
/bg
/bg list
/bg output <returned-task-id>
/bg cancel <returned-task-id>
```

The commands inspect the same jobs without asking a model to perform the operation. Start a command through the agent tool; there is no second shell parser in `/bg`.

A fixed widget **above the editor** shows each task's ID, status, elapsed time, runtime limit and description. It coexists with Scheduler, Todo, and Herdr widgets. Finished rows remain for five seconds; hiding a row does not delete its record. RPC gets a compact active count; non-interactive tools work without the widget.

Completion, failure, cancellation, timeout and output-limit termination each send one `followUp` message to the main agent. It waits for the current turn, rather than interrupting it. Notifications contain metadata and a log path, **not the output body**. The agent can call output when it needs the details.

## Output and safety limits

| View | Limit |
| --- | --- |
| Model-visible output | Last 2000 lines or 50 KiB, whichever is reached first, like Bash |
| Codemode's `structuredContent.output` | Up to 1 MiB of raw log bytes; larger logs keep their first and last 512 KiB with an omission marker |
| Disk capture | 32 MiB per task, 256 MiB total per session |

Display/program-view truncation does **not** stop the command. Disk limits **do** stop the overflowing task with `output_limit`; a full session budget rejects new starts. Nothing silently evicts old logs.

Output includes a log path for further reads. `truncated` describes the program view, not disk capture. `task.capture_complete` is false while running or when log data was lost. The states are `running`, `succeeded`, `failed`, `cancelled`, `timed_out` and `output_limit`.

Output streams to private temporary logs (directory 0700, files 0600 on Unix), with bounded memory and range-limited reads. Log errors stop the task and are reported. Stdout and stderr are merged; strict ordering across the two streams is not promised. Logs and command arguments can contain secrets: choose commands accordingly.

## Codemode and Bash

Use Bash when you need a command's result before proceeding. Codemode composes tool calls and filters their results; it does not itself own background jobs.

Codemode can start a managed job and finish immediately:

```javascript
const started = await tools.background_task({
  action: "start",
  command: "sleep 10; printf 'done\\n'",
  timeout: 120,
});
text(started.task);
```

Later scripts can list, read, or cancel the job. This does not hold a Codemode worker open. Merely starting an unawaited Bash call is different: Codemode cancels unfinished nested calls when its script ends.

The tool description is compact. This package adds no `promptGuidelines` or extra global system-prompt rules.

## Lifetime and scope

- Exit, new/resumed/forked sessions and reload terminate active tasks, remove the widget and timers, and delete this package's captured logs. Commands' own files are left alone. History is not restored.
- Aborting the main agent's current turn does not cancel an accepted job. Use cancel or `/bg cancel`.
- Cancellation and runtime limits stop the native shell process group. Scripts must wait for their own work. Daemonized/detached commands (`nohup`, `setsid`, self-backgrounding processes), existing PID adoption, PTYs and interactive stdin are not supported.
- This is a distinct **local execution** tool. A third-party sandbox or remote backend installed only for Bash does not automatically cover it. Enable it only where direct local shell execution is permitted.
- It is not an OS sandbox: CPU/memory quotas, cleanup after SIGKILL/power loss, automatic retries, deadline renewal and persistence are out of scope. Native signal delivery and timers are best-effort.
- A completion message already queued in Pi cannot be selectively withdrawn. Shutdown prevents new messages from old jobs; it cannot retract one already delivered to the host.

## Remove

For a standalone installation:

```bash
pi remove npm:@maxiaochao/pi-background-tasks
```

With the toolkit, disable its Background Tasks extension through `pi config` instead of removing a separate package.

For deterministic, real-process, real-TUI and media checks, see [TESTING.md](TESTING.md).
