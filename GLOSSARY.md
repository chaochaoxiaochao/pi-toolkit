# Pi Toolkit

Pi Toolkit develops editing extensions and evaluates whether their tool protocols improve exact file-editing outcomes without weakening mutation safety.

## Language

**Agent Benchmark**:
A model-driven comparison in which isolated agents receive the same editing tasks and their complete workspaces are verified byte for byte.
_Avoid_: Parser benchmark, unit benchmark

**Protocol Regression**:
A deterministic fixture that exercises one editing-protocol behavior directly, without model sampling.
_Avoid_: Benchmark task, model comparison

**Safety Regression**:
A Protocol Regression whose correct outcome is rejection with no workspace mutation.
_Avoid_: Failed edit, failed benchmark

**First Exact**:
An Agent Benchmark task whose complete workspace matches the expected bytes after the initial agent round.
_Avoid_: First-call success

**Final Exact**:
An Agent Benchmark task whose complete workspace matches the expected bytes after the permitted recovery rounds.
_Avoid_: Eventual success

**Recovery**:
A continuation in the same Agent Benchmark session and workspace after verifier feedback; it is not an independent observation.
_Avoid_: Retry, rerun

**Paired Regression**:
An Agent Benchmark task passed by a baseline arm and failed by the local arm under the same frozen task manifest.
_Avoid_: Safety Regression

**Neutral Cohort**:
The 80-task proportional sample that preserves the Explicit Edit task-family distribution.
_Avoid_: Random tasks

**Challenge Cohort**:
The 20-task declared supplement that increases coverage of selection, multi-file, cross-file, block, literal, and Unicode editing risks.
_Avoid_: Hand-picked wins

**Execution Plan**:
A branch-local, user-visible sequence of upcoming work that preserves the user's intent and order. It is not hidden reasoning, a completion report, or a general task manager.
_Avoid_: Todo list, internal checklist

**Current Plan**:
The unfinished portion of an Execution Plan: exactly one doing step followed by zero or more todo steps. Model-facing Todo results and the widget show only this snapshot.
_Avoid_: Full history, all todos

**Background Task**:
A local shell command owned by one Pi session that runs after the model's turn and reports its completion to the main agent.
_Avoid_: Subagent, background job pane

**Task View**:
A read-only Herdr pane that shows one Background Task's command and live output. Closing it never affects the task.
_Avoid_: Task pane, terminal task

**Plan History**:
The done and cancelled steps retained on the active conversation branch and shown by `/todos` together with the Current Plan.
_Avoid_: Current Plan

### Ticket Loop

**Ticket Loop**:
The automated implementation of every ticket under one approved spec, ending when all tickets are Accepted or the loop pauses for the user.
_Avoid_: Impl loop, implements

**Coordinator**:
The main Pi session that selects unblocked tickets, dispatches Ticket Sessions, judges their results, and merges them.
_Avoid_: Main agent, orchestrator, scheduler

**Ticket Session**:
A full interactive Pi session in Herdr that implements exactly one ticket in a fresh context and may use its own subagents.
_Avoid_: Subagent, worker

**Accepted**:
The state of a ticket whose evidence the Coordinator has verified and whose branch is merged. Only Accepted tickets unblock their dependents.
_Avoid_: Done, finished, completed
