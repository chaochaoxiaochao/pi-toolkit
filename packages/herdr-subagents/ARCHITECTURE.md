# Herdr Subagents architecture and decision-pause design

This document describes the package's current architecture, the problems exposed by failure and blocking semantics, and the target decision-pause model. Sections marked **Current** describe implemented behavior. Sections marked **Target** are an implementation plan, not the current contract.

## 1. Product boundary

Herdr Subagents runs ordinary interactive Pi Agents in visible Herdr panes and keeps their complete sessions and results in project-local durable records. The parent receives compact status, questions, summaries, and document paths.

A batch is a resource-bounded collection of **independent tasks**:

- array order controls FIFO scheduling, pane numbering, and result order;
- `concurrency` controls how many tasks may be active at once;
- a batch containing a write-capable persona is forced to concurrency one;
- concurrency one does **not** express `A -> B` dependency semantics;
- tasks that consume another task's result must be orchestrated by the parent as separate runs.

The package does not currently need a DAG scheduler. If dependency workflows become a first-class product requirement, they should be introduced explicitly with dependency and skip-propagation semantics instead of inferred from array order.

## 2. Architecture overview

```text
Parent Pi tool call
        |
        v
Extension lifecycle and foreground handoff
        |  extensions/herdr-subagents.ts
        v
Global run dispatcher ---- persisted background queue
        |                  src/dispatcher.ts, src/queued-runs.ts
        v
Batch runner and bounded workers
        |  src/batch-runner.ts
        +---- pane allocation / Herdr Agent lifecycle
        |     src/run-pane-allocator.ts, src/live-agent.ts, src/herdr.ts
        +---- attempt-scoped structured report
        |     src/attempts.ts, src/protocol.ts, src/records.ts
        +---- durable run/task/session records
        |     .pi/herdr-subagents/runs/<run>/...
        v
Aggregate status, monitor, control, recovery and cleanup
           src/run-status.ts, src/status.ts, src/fleet*.ts,
           src/blocking.ts, src/historical-resume.ts,
           src/reconcile.ts, src/tab-cleanup.ts
```

### Responsibilities

| Layer | Responsibility |
| --- | --- |
| Extension | Register tools, bind parent-session lifetime, return foreground results, send final background follow-ups. |
| Dispatcher | Give one run ownership of the global submission lane and queue later submissions FIFO. |
| Batch runner | Persist the run, start bounded workers, allocate one pane per task, and aggregate task results. |
| Live Agent adapter | Start or continue an interactive Pi Agent and distinguish runtime telemetry from business reports. |
| Records | Atomically persist run, task, turn, report, attempt, ownership, and resume state. |
| Control | Inspect, answer, retry/continue saved work, cancel, resume history, and clean archives. |
| Recovery | Reconcile stale owners and processes, settle abandoned work, and clean identifiable tabs. |
| Fleet | Project durable business state plus transient runtime telemetry into the parent UI. |

## 3. Authoritative state and invariants

1. A matching attempt-scoped `subagent_report` is authoritative for business `completed`, `blocked`, or `failed`.
2. Herdr `working`, `blocked`, `idle`, and `done` are transport/runtime telemetry. Herdr UI `blocked` projects to `waiting_interaction`; it does not make the business task blocked.
3. Each task owns one pane and one Pi session. A pane is never reused by another task.
4. A task session has at most one writer. Task resume locks enforce that invariant.
5. Shared `run.json` changes occur under the short-lived run-state lock. An Agent turn never holds that lock.
6. Every new prompt has a unique attempt ID. A late report from an older attempt cannot settle a newer attempt.
7. Task and report state is persisted before it is exposed as an actionable parent result.
8. Running work is not forcibly interrupted merely because a sibling needs a decision.

## 4. Current execution flow

### Submission

1. Tool parameters are validated.
2. Configuration and personas are loaded and resolved.
3. A stable run ID is allocated.
4. Background runs are durably queued before dispatch; foreground runs wait for the dispatcher lane.
5. The batch runner creates `run.json`, task directories, task records, prompts, and session paths.
6. Effective concurrency is bounded by settings and forced to one if any persona is write-capable.

### Task execution

Each worker repeatedly claims the next FIFO task, allocates a pane, starts an interactive Pi Agent, waits for the matching structured report, persists the result, and claims another task. A failed task does not currently stop that worker. A blocked task stops only its worker lane.

### Current foreground outcomes

| Event | Current foreground behavior | Queued siblings |
| --- | --- | --- |
| All tasks complete | Return after the whole batch settles. | Completed normally. |
| Failure with concurrency one | Continue later tasks, then return terminal `failed` or `partial`. | Continue automatically. |
| Failure with concurrency greater than one and unfinished siblings | Persist the failure, return early, detach the batch, and let it finish in the background. | Continue automatically. |
| Business block | Wait for the other worker lanes to settle, then return the question and retain the dispatcher lane. | A blocked worker stops, but other workers keep claiming tasks. |
| Herdr UI block | Keep waiting for an authoritative report while showing `waiting_interaction`. | Unchanged. |

The failure and block rows are asymmetric: parallel failure gives control back promptly, while block may withhold its question until unrelated work finishes. Serial failure also assumes later tasks are independent. The target design removes both ambiguities.

## 5. Dispatcher ownership in plain language

The dispatcher is the global submission lane, not the task-concurrency limiter.

| Operation | Meaning |
| --- | --- |
| `detach` | The run continues in the background but gives up the submission lane, so another run may start. |
| `retain` | The run is waiting for a parent decision and keeps the lane; a new foreground run is rejected and a background run stays queued. |
| `release` | A retained run is resolved or cancelled and gives up the lane. |

Current parallel failure uses `detach`; current business block eventually uses `retain`.

## 6. Target decision-pause model

### Goal

Any actionable business problem returns control to the parent immediately and stops new task dispatch until the parent decides what to do. Already-running siblings are allowed to finish safely.

```text
A reports failed or blocked
        |
        +---- persist task/report/attempt state
        +---- pause new queue claims
        +---- return pause details to the parent immediately
        +---- retain the dispatcher lane
        |
B and C were already running ---- continue to a terminal report
D and E were queued ------------- remain queued
```

"Pause" means pausing **dispatch**, not freezing an Agent process at an arbitrary instruction. Forcibly suspending or cancelling running siblings could leave tools, file writes, or external operations in an unknown state.

### Run control state must be separate from task outcome

The current `RunStatus` reuses task statuses and aggregates them into `running`, `blocked`, `partial`, and terminal values. That combines two different questions:

1. May the scheduler dispatch more work?
2. What outcomes have tasks produced?

The target model separates them conceptually:

```ts
type RunPhase = "queued" | "running" | "paused" | "cancelling" | "settled";
type RunOutcome = "completed" | "partial" | "failed" | "cancelled";
```

The public status projection may continue exposing `status: "paused"` for convenience, but durable control logic should use the phase. While a run is paused, some task activities may still be `running` as already-started siblings settle.

### Durable pause reasons

A pause is tied to a specific task attempt so stale answers cannot resolve newer work:

```ts
interface PauseReason {
  taskId: string;
  taskOrder: number;
  attemptId: string;
  kind: "blocked" | "failed";
  resolution: "pending" | "responded" | "retried" | "continued" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
}
```

The durable reason should reference authoritative task/report records instead of duplicating mutable summary, question, and error text. Status and tool responses project a detailed view:

```json
{
  "status": "paused",
  "pauseReasons": [
    {
      "task": 1,
      "kind": "failed",
      "summary": "Authentication review failed.",
      "error": "Provider request failed.",
      "allowedActions": ["retry", "continue", "cancel"]
    }
  ]
}
```

Multiple already-running siblings may subsequently fail or block. Their reasons accumulate. No queued task starts while any pending reason remains.

### Decision actions

| Reason | Action | Effect |
| --- | --- | --- |
| `blocked` | `respond` | Continue the same live/saved session with the answer. |
| `failed` | `retry` | Retry or continue the selected task explicitly; never infer a task. |
| `failed` | `continue` | Accept that task's failure and allow the run to proceed without retrying it. |
| Any | `cancel` | Cancel running and queued work and settle the run as cancelled. |

`respond` should no longer be overloaded for failed tasks once `retry` exists. This makes control intent and audit history explicit.

The queue resumes only when every pending pause reason is resolved. A retry or response that blocks/fails again creates a reason for the new attempt.

### Failure classification

Both child-reported failures and generated terminal failures can pause a run:

- valid `subagent_report(status="failed")`;
- child process or prompt API terminal error without a valid report;
- Agent settled without publishing a report after the grace period;
- pane or Agent startup failure.

Ambiguous prompt delivery remains `delivery_unknown` while the child is alive and must not be converted into a retryable failure. Retry safety should be projected explicitly when the implementation can prove whether a prompt was submitted; the system must never automatically replay an attempt with uncertain side effects.

### Foreground handoff

Failure and block should share one foreground-handoff mechanism:

1. observe an actionable, durably persisted task attempt;
2. atomically pause dispatch and register its reason;
3. detach the parent tool-call abort signal without cancelling the run;
4. retain dispatcher ownership;
5. return the projected pause details immediately;
6. keep already-running siblings and final background lifecycle tracking alive;
7. send at most one terminal follow-up after the run eventually settles.

The event-specific policy only determines allowed decisions and response rendering. It should not duplicate lifecycle, persistence, or notification machinery.

## 7. Target flows

### Independent parallel tasks

```text
Submit A, B, C, D with concurrency 3
A/B/C start; D queued
A fails
  -> run phase paused
  -> D remains queued
  -> parent receives A failure immediately
B/C continue safely
Parent retries A, continues past A, or cancels
  -> once all pending reasons are resolved, dispatch may resume
```

### Serial tasks

```text
Submit A, B, C with concurrency 1
A starts; B/C queued
A fails or blocks
  -> run phase paused
  -> B/C do not start
  -> parent decides
```

This makes serial execution safer, but still does not make B consume A's result. A real `A -> B` workflow remains parent-orchestrated as separate runs.

### Runtime-only Herdr block

```text
Herdr reports blocked
  -> task remains business running
  -> Fleet shows waiting_interaction
  -> no decision pause yet
Child publishes matching structured blocked report
  -> create pause reason
  -> return exact question
```

## 8. Configuration: keep fewer concepts, not necessarily fewer files

### Current user-facing sources

| Scope | Runtime settings and persona overrides | Persona definitions and prompts |
| --- | --- | --- |
| Project | `.pi/herdr-subagents.json` | `.pi/herdr-subagents/agents/*.md` |
| Global | `~/.pi/agent/herdr-subagents.json` | `~/.pi/agent/herdr-subagents/agents/*.md` |
| Package | Built-in defaults | Built-in `agents/*.md` |

The two formats have distinct jobs:

- JSON is suitable for environment policy and small overrides.
- Markdown frontmatter plus body is suitable for a named persona and its system prompt.

Merging them into one physical file would either put long prompts into JSON or require runtime policy to be parsed from Markdown. It would also force users to copy an entire built-in persona merely to override its model. Therefore the two physical forms should remain.

### Sources of confusion to remove

1. Persona Markdown and JSON both expose `model`, `thinking`, `skills`, and `extensions`; this is intentional override layering but must be described as one resolution pipeline.
2. Call-level task model overrides are resolved later in `tool.ts`, after configuration loading.
3. TypeBox validates shape while `validation.ts` validates action-dependent requirements; these are complementary but currently look like duplicated validation.
4. Downstream modules receive partially resolved values instead of one canonical run plan.

### Canonical normalization boundary

All sources should be normalized once before persistence or dispatch:

```text
Built-in defaults
  <- global JSON
  <- project JSON
  <- effective persona Markdown
  <- global persona override
  <- project persona override
  <- call/task override
        |
        v
ResolvedRunPlan + diagnostics + source metadata
```

A target canonical plan can contain only execution-ready values:

```ts
interface ResolvedRunPlan {
  label: string;
  requestedConcurrency: number;
  effectiveConcurrency: number;
  tasks: Array<{
    name: string;
    prompt: string;
    persona: string;
    access: "read" | "write";
    model?: string;
    thinking?: string;
    tools?: string[];
    skills: string[];
    extensions: string[];
    systemPrompt: string;
  }>;
  provenance: Record<string, string>;
  diagnostics: string[];
}
```

After this boundary, the batch runner, persistence, recovery, and UI should not know about global/project/package precedence.

### Configuration reductions

Do:

- retain one JSON settings file per scope and one persona directory per scope;
- centralize precedence and call overrides in a single `resolveRunPlan` step;
- expose resolved values and provenance through `list/settings` diagnostics;
- state prominently that batch tasks are independent;
- make decision pause the safe fixed behavior rather than adding a new failure-policy option;
- keep runtime-only Herdr states out of business configuration.

Do not add now:

- DAG or `dependsOn` configuration;
- configurable `failurePolicy` variants;
- separate block/failure handoff settings;
- automatic retry counts;
- configuration for dispatcher `detach`/`retain` behavior.

These options would multiply state-machine branches before a demonstrated need. The safe decision gate should be the invariant.

### Validation ownership

- `parameters.ts`: public schema, field types, basic bounds, and model-visible descriptions.
- `validation.ts`: cross-field and action-specific requirements.
- `resolveRunPlan`: persona existence, precedence, capability constraints, effective concurrency, and canonical values.
- runtime state machine: whether an action is legal for the selected run/task/attempt.

This division avoids both duplicated validation and an oversized configuration loader.

## 9. Implementation seams for the target model

| Area | Required change |
| --- | --- |
| `records.ts` | Separate run phase/outcome, persist attempt-scoped pause reasons, and preserve backward-compatible reads. |
| `run-status.ts` | Aggregate task outcomes independently from scheduler phase. |
| `batch-runner.ts` | Add a shared dispatch gate; stop queue claims immediately when a reason is registered. |
| `extensions/herdr-subagents.ts` | Replace failure-only early return with shared actionable-event handoff. |
| `dispatcher.ts` | Retain paused runs and release only after resolution/cancellation; keep ownership transitions explicit. |
| `blocking.ts` / control | Split blocked `respond` from failed `retry`; add explicit `continue`. |
| `continue-run.ts` | Resume queued dispatch only when no pending reason remains. |
| `reconcile.ts` | Recover paused runs and cancel them when their owning parent session disappears. |
| `status.ts` / Fleet | Show pause reasons, allowed actions, and still-running sibling activity together. |
| `parameters.ts` / `validation.ts` | Add `retry` and `continue`, clarify independent-task semantics. |
| tests | Cover immediate handoff, dispatch pause, multiple reasons, resolution races, restart recovery, and exactly-once final notification. |

## 10. Required tests

1. Serial failure pauses before the next queued task starts.
2. Serial block pauses before the next queued task starts.
3. Parallel failure returns immediately while already-running siblings continue.
4. Parallel block returns immediately while already-running siblings continue.
5. Queued siblings never start while a reason is pending.
6. A second already-running sibling can add another pause reason without losing the first.
7. Resolving only one of multiple reasons does not resume dispatch.
8. `continue` preserves the failed task result and eventually produces `partial` when other tasks succeed.
9. Retry/response is scoped to task and attempt; stale resolution is rejected.
10. Herdr UI `blocked` alone never pauses business dispatch.
11. `delivery_unknown` never causes automatic replay.
12. A paused run retains the dispatcher lane; foreground submissions fail fast and background submissions remain queued.
13. Cancellation settles running/queued tasks and releases the retained lane.
14. Parent-session shutdown and startup reconciliation do not leave ownerless paused work.
15. Foreground handoff and final follow-up are each delivered at most once.

## 11. Non-goals

- Inferring dependencies from task order or prompt text.
- Freezing arbitrary live Agent processes.
- Automatically retrying failed or ambiguously delivered prompts.
- Treating Herdr UI state as business truth.
- Loading complete child results into parent context.
- Adding policy configuration for every state transition.

## 12. Summary

The architecture becomes clearer when it separates four concerns:

1. **Task outcome:** what each child authoritatively reported.
2. **Run phase:** whether new work may be dispatched or a parent decision is required.
3. **Runtime telemetry:** what Herdr currently observes without changing business truth.
4. **Dispatcher ownership:** whether another run may enter the global submission lane.

The immediate next design step is a shared decision-pause and foreground-handoff mechanism for business failure and block. Configuration should be simplified through one canonical resolution boundary and fewer policy choices, not by forcing settings and persona prompts into one file.
