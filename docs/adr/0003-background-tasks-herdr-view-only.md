---
status: accepted
---

# Background Tasks use Herdr only to display, never to execute

Users want to see what a background task runs and how its output updates, as they can with Herdr subagents. Two designs were considered. Running the command inside a Herdr pane's PTY would show colour and TTY-only progress bars, but Herdr's `pane run` returns no exit code and owns no timeout, process-group cancellation or log budget. Exit status, cancellation and limits would need a second, Herdr-specific implementation with different reliability from the local one, and both paths would need testing. Background Tasks therefore keeps one execution path, Pi's `createLocalBashOperations()`, and inside Herdr opens a read-only pane that prints the command and follows the captured log with `tail -f`.

## Consequences

Status, exit codes, timeouts, cancellation, log limits and completion notifications behave the same inside and outside Herdr. The pane is a viewer: closing it never cancels the task, and Herdr failures only lose the view. Commands still run without a TTY, so tools that detect one may drop colour or animated progress. If that matters, the next step is a local PTY (for example `script -qfc`) with control sequences stripped from the model's output view, before considering execution inside Herdr.
