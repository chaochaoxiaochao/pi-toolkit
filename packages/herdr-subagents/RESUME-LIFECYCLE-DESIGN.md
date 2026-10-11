# Historical resume and Herdr lifecycle design

## Invariants

- A task session has one writer. `tasks/<task>/.resume.lock` is held for the whole
  historical turn, so a second resume of that task fails immediately.
- Different settled tasks in one run may resume concurrently. They share one new
  resume tab and each owns a distinct pane.
- `run.json` is changed only while holding the short-lived `run/.state.lock`.
  The lock covers shared tab allocation, active-resume membership, aggregate
  status, and final cleanup ownership; it never covers an Agent turn.
- A structured `subagent_report` is the authority for business completion,
  failure, or `needs-input`. Herdr UI state is runtime telemetry only.

## Durable resume state

`run.json.resume` contains the shared resume tab identity and an `active` map
from task id to pane, generation, attempt, owner identity/token, and phase. The
first entrant creates the tab while holding the run lock and uses its root pane.
Later entrants split a pane in that tab. Allocation is first persisted as
`allocating`; after task/turn records durably identify the attempt it advances to
`running`. Reconciliation can therefore fail an abandoned allocation or promote
a fully persisted attempt after a crash at either boundary.

When a turn settles, its task/report/turn are persisted first. Under the run
lock, the task is then removed from `resume.active`, all task files are read to
derive the run status, and the caller that observes an empty map claims final
tab cleanup. A failed turn removes only itself; siblings keep running. A
`needs-input` turn stays represented by its blocked task/pane until `respond`
settles it. Tab cleanup occurs only when no resume task is running or blocked.

The run lock prepares its owner metadata in a private directory and atomically
publishes the complete lock directory. Contenders wait with abort support. A
legacy ownerless initialization has an explicit expiry lease and is reclaimed
only after directory-identity revalidation; a dead-owner lock is atomically
renamed away before retry. Task locks use the same stale-owner recovery but
contention is reported instead of waited on.

## Recovery and cancellation

Reconciliation validates each `resume.active` member against its attempt and
task record: dead panes/processes become failed or cancelled using the existing
attempt failure rules, stale members are removed under the run lock, and the
last remover atomically claims the generation's tab cleanup. Cancellation is
member-scoped by owner and attempt, so one parent cannot cancel a sibling
owner's turn. Every `run.json` reconciliation/cancellation update is a locked
read-modify-write.

This recovery is best effort, not complete. Herdr 0.9.2 provides no idempotency
key for tab creation or pane splitting. If the process receives `SIGKILL` after
Herdr creates the external resource but before its ID is durably persisted, the
resource cannot be identified by this state machine and may remain orphaned.

## Herdr runtime projection

`agent prompt --wait` can return `idle`, `done`, or `blocked`; `agent get` exposes
`working`, `blocked`, `idle`, `done`, or `unknown`. While a prompt is pending we
poll that state and persist/emit a separate runtime state:

- `working` -> `working`
- `blocked` -> `waiting_interaction` (Task remains `running`)
- `agent_prompt_stalled`/timeout -> `delivery_unknown`; while the attempt state
  is `working` and the child process is alive, wait for its report and never resend
- `idle`/`done` with a valid report -> use the report's business terminal state
- `idle`/`done` without a report after a short file-publication grace -> Task `failed`
- prompt/process/API terminal error without a valid report -> Task `failed`
- `agent get` query failure -> diagnostic only; continue waiting for report or
  independent pane/process evidence

When a scoped report appears, its waiter aborts and explicitly awaits the
outstanding `agent prompt --wait` command before returning. Runtime writes
revalidate the current attempt and active task status, so late transport
telemetry cannot overwrite a report-derived terminal state.

Herdr's `blocked` is not converted to business Task `blocked`; only a valid
`subagent_report(status="needs-input")` does that. Runtime state, pane id, and a
short diagnostic are exposed in task records, activity, and Fleet without replacing
Task status.

`retrying` is reserved in the runtime schema and Fleet renderer but is not emitted
by the current child extension. Herdr has no retrying state, and Pi's public
extension lifecycle does not expose an auto-retry hook or a reliable `willRetry`
field. Inferring it from `agent_end`/`agent_start` would also label ordinary queued
continuations as retries, so the implementation deliberately does not fabricate it.
