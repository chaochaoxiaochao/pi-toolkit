# AGENTS Evaluation Redesign

## Context

The repository-level `global/AGENTS.md` has been restored with `git checkout -- global/AGENTS.md` and is outside the new experiment. The standalone evaluator will use the real current `~/.pi/agent/AGENTS.md` directly for the `installed` condition and will not synchronize or rewrite it.

The first standalone workflow calibration produced `28/30` resolved none runs after fixture repairs. This is still too close to a ceiling for the primary outcome. It also confirms that realistic-looking prompts can remain implementation-leaky when they name all behavior, modules, and verification expectations. These results are calibration artifacts only; they must not be used for an installed-vs-none conclusion.

The next task revision will increase engineering realism without hiding requirements: larger existing feature slices, multiple entry points, compatibility/migration behavior, repository evidence in docs/tests, and task-level acceptance criteria that are all discoverable before implementation. The main suite must not rely on undocumented hidden sentinels or a particular test-file layout.

Because several global rules are fundamentally about decomposition, checkpoints, handoffs, and failure coordination, the standalone repository also defines a separate multi-agent track. Its results are not pooled with single-agent resolution.

## Initial Findings

- `Think Before Coding`: existing cases test evidence selection, but do not test whether the agent handles a realistic requirement with multiple plausible interpretations.
- `Simplicity First`: existing cases mostly request one small function; they do not create credible opportunities for speculative abstractions, dependencies, or recovery logic.
- `Surgical Changes`: existing scope bait is useful, but needs realistic feature work with unrelated pre-existing changes and multiple valid implementation locations.
- `Read Before You Write`: caller observation is measured, but prompts often name the relevant caller graph instead of requiring discovery.
- `Goal-Driven Execution`: tests and regression assertions are measured, but not decomposition of a feature into acceptance criteria and verification across suites.
- `Checkpoint Long-Running Work`: the current harness cannot reliably observe intermediate checkpoints in a single Pi run; this should be treated as a separate coordination experiment or removed from correctness claims.
- `Fail Visibly, Not Silently`: existing missing-lint coverage is narrow; broader partial-failure and unavailable-input workflows are needed.
- `Reuse Before Writing`: existing helper-reuse cases are the strongest current coverage, but should be tested in realistic feature development with both compatible and incompatible existing helpers.
- `Use Available Editing Tools`: this is harness-specific and should be measured separately from repository engineering quality.

Public guidance reviewed during planning consistently favors concise, executable instructions, exact commands, scoped rules, observable acceptance criteria, and explicit failure reporting. It does not establish that any wording universally improves model performance, so the new repository must preserve controlled A/B evidence.

## Open Decisions

- Proposed standalone repository: `/home/maxiaochao/subject/github/agents-md-eval` (name can be changed before implementation).
- Proposed treatment arms: `none` and `installed` only. `none` runs with `--no-context-files`; `installed` directly loads the real current `~/.pi/agent/AGENTS.md`. The evaluator records the installed-file hash for every matrix and never copies or modifies the file.
- Proposed workload: 12-20 realistic engineering tasks, with multi-file feature development as the primary workload and small field edits retained only as smoke controls.
- Proposed execution: isolated Git fixtures, fixed model, repeated trials, deterministic hidden tests, trajectory evidence, and optional Herdr panes for independent live runs or orchestration experiments.

## Approach

1. Create a standalone evaluation repository without changing the pi-toolkit evaluation implementation or either AGENTS file during the design phase.
2. Treat the real current `~/.pi/agent/AGENTS.md` as the installed condition. Record its hash in every dry-run and live artifact; use `--no-context-files` for the none condition.
3. Define both a single-agent rule-to-failure-mode matrix and a coordination-track matrix before authoring fixtures. Each rule must have a concrete engineering failure, a task that makes that failure plausible, an observable trajectory or handoff signal, and an outcome grader.
3. Build a new task taxonomy centered on feature development:
   - multi-file feature implementation with existing architecture;
   - change propagation across callers and compatibility surfaces;
   - public/compatibility/integration test planning;
   - incomplete or failing verification commands;
   - scope and unrelated-change pressure;
   - helper reuse versus incompatible helper rejection;
   - requirements with reversible ambiguity and repository evidence;
   - long-running or coordinator-level experiments as a separate track.
4. Calibrate every candidate task under `none` first. Retain tasks where baseline behavior is neither ceiling nor floor, ideally 20-80% resolution or a clearly measurable process failure despite passing tests. A 28/30 or higher none result is a failed discrimination gate, even if process violations are present.
5. Run independent adversarial review after calibration. Reviewers must reject any case where the hidden test requires an undocumented value, sentinel, file, error type, or implementation path, or where the prompt names enough structure to make the targeted behavior trivial.
6. Run a pilot with `none` versus the real current `~/.pi/agent/AGENTS.md` only after the revised task pool passes the discrimination and adversarial-review gates. This establishes whether the task pool can detect value from the existing rules.
7. Compare wording variants only after the two-arm baseline task pool has demonstrated discrimination. Use per-task paired outcomes, regression checks, score, scope violations, test/verification behavior, duration, tool calls, tokens, and provider cost when available.

## Test Cases And Evaluation Scheme

### Case Design Principles

The primary suite will evaluate feature development in small but realistic repositories, not isolated field edits. Each fixture will contain 3-8 source modules, an existing public API, at least one caller or compatibility surface, existing tests, and one or more realistic distractions such as unrelated dirty files, a similar but incompatible helper, or a narrow public test that does not cover the full contract.

Prompts will describe user-visible behavior, compatibility requirements, and completion criteria. They will not name the target file, caller graph, helper to reuse, or exact implementation order. Repository documentation and code will contain the evidence an agent should discover. This prevents the prompt from giving away the behavior that AGENTS.md is supposed to encourage.

Small one-function edits will remain as two smoke controls only. They will not determine the primary conclusion.

### Rule-To-Failure Matrix

| Rule | Engineering failure to induce | Observable evidence |
|---|---|---|
| `Think Before Coding` | Choose a plausible but unsupported interpretation of defaults, precedence, or compatibility behavior instead of resolving it from repository evidence | Correct boundary behavior, relevant evidence read, assumption stated only when material |
| `Simplicity First` | Add a new abstraction, dependency, configuration layer, or recovery behavior when an existing extension point is sufficient | Correct behavior with minimal relevant patch, no unnecessary dependency/file, no unsupported recovery |
| `Surgical Changes` | Fix nearby bait, reformat unrelated files, modify a protected compatibility surface, or overwrite pre-existing user changes | Changed-file allowlist, protected-file hashes, diff scope, preservation of baseline changes |
| `Read Before You Write` | Patch the first visible caller without tracing the shared implementation and sibling callers, or miss an existing contract | Relevant modules observed before mutation, shared/sibling behavior preserved, hidden caller tests pass |
| `Goal-Driven Execution` | Implement only the headline behavior and omit a secondary acceptance criterion or one test suite | All acceptance contracts pass, regression assertion exists, complete suite runs after final mutation |
| `Fail Visibly, Not Silently` | Treat a failed/unavailable check as success, silently skip a required input, or claim completion after partial verification | Exact command outcomes and final report distinguish passed, failed, skipped, and not-run |
| `Reuse Before Writing` | Duplicate a repository primitive, or reuse a similarly named helper with incompatible semantics | Runtime/helper behavior, no duplicate implementation, correct compatible/incompatible helper decision |
| `Use Available Editing Tools` | Assume an unavailable shell editing command and lose work or stop unnecessarily | Separate harness/tool-use metric only; never mixed with product correctness |
| `Checkpoint Long-Running Work` | Lose track of partial progress during a long multi-stage task | Separate Herdr/coordinator experiment only; not claimed from a single opaque runner trajectory |

### Primary Feature Task Families

The initial standalone repository will implement 12-20 cases across these families, with at least one case per measurable rule group:

1. Configuration and migration feature: add a user-visible option across parser, defaulting, serialization, CLI/API callers, and compatibility tests. The key risk is choosing truthiness or precedence semantics without reading repository evidence.
2. Multi-caller behavior change: change a shared normalization, escaping, or serialization policy while preserving distinct caller output contracts. The key risks are caller-only patches and missed transitive callers.
3. Existing-helper feature: add a new endpoint, report, or renderer that must use an existing repository primitive exposed through an index/barrel. Include runtime overrides or call counters so duplication can be rejected behaviorally.
4. Similar-helper trap: provide a nearby helper with a similar name but incompatible semantics. The feature requires deciding from contract evidence whether to reuse it or write a small local adapter.
5. Multi-suite feature: implement a feature whose public test covers the ordinary path while compatibility and integration suites cover falsy values, legacy output, or serialized responses.
6. Failure-and-verification workflow: require a normal test command plus a known unavailable or failing optional command. The target is both the code change and an accurate final verification report.
7. Scope-pressure feature: leave unrelated pre-existing changes, generated-looking files, and a documentation typo in the fixture. The requested feature spans several relevant files but must not absorb the bait.
8. Evidence-driven ambiguity: provide two plausible interpretations in code/docs, with one supported by existing callers or tests. The agent should inspect evidence and proceed without unnecessary clarification when the ambiguity is reversible.
9. Narrow-contract feature with tempting recovery: require a documented narrow input domain while exposing malformed inputs that could tempt fallback/coercion. Hidden tests verify propagation or rejection rather than speculative recovery.
10. Transactional or asynchronous feature: add retry, coalescing, cancellation, or rollback behavior across several modules while preserving ordering and failure contracts. This measures decomposition and verification under stateful behavior.
11. API compatibility feature: add pagination, repeated query parameters, versioned payloads, or a new adapter while preserving an existing public caller. The task requires planning all affected surfaces and complete regression coverage.
12. Small controls: retain two explicit single-function changes to confirm the runner and grader, but report them separately from the feature-development result.

### Planning And Workflow Measurement

The prompt for a multi-stage feature will list product outcomes, compatibility constraints, and verification expectations without prescribing a plan. The grader will not require a particular prose template. It will measure whether the agent:

- inspected relevant code and tests before the first mutation;
- discovered the affected modules rather than relying only on prompt-named paths;
- covered all requested sub-behaviors and compatibility surfaces;
- added executable regression coverage for the changed behavior;
- ran the complete relevant suite after the final mutation;
- preserved unrelated files and existing contracts; and
- reported partial failures and remaining gaps accurately.

A plan message may be recorded as a secondary trajectory metric, but a plan without corresponding implementation evidence receives no credit. The main correctness decision remains hidden behavior plus regression tests.

### Two-Arm Protocol

Only two conditions are used:

- `none`: run Pi with `--no-context-files`.
- `installed`: run Pi normally so it loads the current real `~/.pi/agent/AGENTS.md` directly.

The evaluator records the absolute installed-file path, SHA-256, model, Pi version, tool set, and all execution arguments. It never copies or edits the installed file. Every task starts in a fresh temporary Git repository outside the evaluated repositories.

Execution phases:

1. Fixture gate: base target tests must fail, oracle patches must pass target and regression tests, protected files must remain unchanged, and wrong/correct controls must pass independent review.
2. None-only calibration: run every candidate case for two exploratory trials. Record task resolution, rule-specific behavior failures, patch scope, tests, duration, tools, tokens, and provider cost. Exclude ceiling/floor cases from the primary suite.
3. Adversarial review: inspect prompts for implementation leakage, graders for implementation prescriptions, and hidden tests for accidental coupling to one correct patch.
4. Reviewed paired pilot: run 12-20 calibrated cases in both conditions for five trials, with the same model and isolated workspace protocol. Use `jobs=1` for reproducibility; Herdr may host independent batches but cannot change the case or scoring protocol.
5. Analysis: report per-case and per-trial paired results, not only aggregate means. Primary metrics are resolution and rule-specific behavior. Secondary metrics are score, violations, test completeness, changed files/lines, duration, tool calls, input/output/cache tokens, and provider-reported cost.

Release gates for an AGENTS change are strict: installed must not have lower resolution than none, no paired `none`-pass/installed-fail result is accepted for the promoted task pool, and no rule-specific behavior may regress. Any efficiency gain is reported separately and cannot compensate for a correctness regression. If the task pool cannot meet this discrimination requirement, the result is `evidence insufficient`, not a reason to alter the grader.

### Multi-Agent Coordination Track

The primary two-arm experiment measures one agent completing one feature in an isolated repository. A separate Herdr track measures a coordinator, workers, and reviewer completing a dependent bundle of feature tickets. It records task decomposition, ownership boundaries, handoff completeness, conflict handling, recovery after a failed worker, integration resolution, duration, and token usage. It does not replace or pool with the primary experiment.

The coordination fixture is one repository-level change split into three dependent tickets:

1. A worker discovers the existing domain contract and implements a shared data-layer change.
2. A second worker updates API and CLI surfaces while preserving a legacy caller and consuming the first worker's handoff.
3. A reviewer runs the complete suite, checks scope and compatibility, and returns actionable findings; the coordinator resolves findings and performs final integration verification.

The fixture contains a real dependency, one protected compatibility surface, one intentionally unrelated dirty file, and a failure injection that makes one worker's first attempt incomplete. Each worker returns a structured handoff containing files inspected, files changed, tests run and outcomes, assumptions, remaining risks, and exact next steps. The coordinator is graded on detecting failed or incomplete handoffs, respecting dependency order, avoiding overlapping ownership, resolving reviewer findings, and refusing to claim completion before the integration gate passes.

Run the same task package in two conditions: all agents use `--no-context-files`, or all agents load the real current `~/.pi/agent/AGENTS.md`. Record every pane/agent prompt, handoff artifact, command result, final repository state, pane lifecycle error, wall time, tool calls, tokens, and provider cost. A passing patch that hides a worker failure does not receive full coordination credit.

This track requires `HERDR_ENV=1`, verified installed CLI syntax, an isolated fixture cwd, and background panes created with `--no-focus`. It is an engineering-workflow comparison; it does not prove that one AGENTS rule caused an effect without an additional rule-group ablation.


Planned in the new repository, not this repository:

- `AGENTS.md` or `README.md`: evaluation repository operating instructions.
- `package.json`: scripts and pinned evaluation dependencies, if needed.
- `cases/`: realistic feature fixtures, prompts, oracles, hidden tests, and rule mappings.
- `cases/rule-matrix.json`: rule-to-failure-mode and measurement specification.
- `runner/`: isolated workspace execution, instruction-arm loading, trajectory capture, and result classification.
- `graders/`: deterministic outcome and behavior graders.
- `experiments/`: reviewed matrices and experiment manifests.
- `reports/`: aggregate reports and calibration summaries.
- `docs/methodology.md`: protocol, interpretation, and limitations.

The current pi-toolkit source, existing reports, `global/AGENTS.md`, and `~/.pi/agent/AGENTS.md` will remain untouched during the design phase. The standalone evaluator reads the installed file but does not modify it.

## Reuse

- Reuse the current fixture concepts: protected files, base/oracle validation, public plus hidden tests, clean Git workspaces, post-public mutation checks, and explicit infrastructure/agent error classes.
- Reuse the current trajectory signals: successful file reads, mutation ordering, exact test-command correlation, changed-file scope, final verification text, and token/duration telemetry.
- Reuse the current model and Pi invocation protocol initially so differences are attributable to task design rather than a new runtime.
- Use Herdr's pane/agent lifecycle only for the separate coordination track; do not use pane layout as a proxy for coding quality.

## Steps

- [x] Confirm the standalone repository name/path and whether it should be created as a sibling directory or under another workspace root.
- [x] Inventory all existing fixtures and classify them as smoke, contract, workflow, or unsuitable for the new primary suite.
- [x] Write the rule-to-failure-mode matrix, including which rules are observable and which require separate experiments.
- [x] Design 12-20 feature-development task templates with realistic repository structure, incomplete prompts, and multiple contracts.
- [x] Implement the standalone fixture format, oracle gate, hidden tests, protected-file checks, and trajectory graders.
- [x] Redesign the primary feature-development fixtures after the first none calibration failed the discrimination gate.
- [x] Run none-only calibration and remove ceiling/floor tasks before any A/B calls.
- [x] Run `none` versus the real current `~/.pi/agent/AGENTS.md` pilot with repeated trials, recording the installed-file hash. The exploratory pilot remains evidence-insufficient and is not a release conclusion.
- [x] Add a candidate concise/example AGENTS variant only after the baseline experiment is discriminative; this is a candidate-only artifact and does not replace installed.
- [x] Run a separate wording-variant pilot and report correctness, behavior, efficiency, cost, and regressions separately. The pilot did not justify promoting the candidate.
- [x] Design the Herdr coordination fixture, handoff schema, failure injection, and integration grader.
- [x] Run a Herdr topology/protocol smoke without model calls before any live coordination experiment.

## Verification

- The current pi-toolkit working tree remains unchanged except for the requested `git checkout` state of `global/AGENTS.md`.
- The standalone repository's first workflow calibration is retained as a failed calibration artifact and is not evidence for an AGENTS effect.
- The revised fixture gate must show every base fixture fails its target contract and every oracle passes before live calls.
- Each task must have an explicit rule target, failure mode, observable trajectory evidence, deterministic outcome grader, and protected files where applicable.
- None-only calibration must report per-task resolution and behavior failures; tasks with ceiling/floor outcomes are excluded from the primary A/B suite.
- Live runs must use reviewed matrices bound to case, grader, runner, model, instruction-arm, and source hashes.
- Final reports must show per-task paired outcomes and distinguish completed, skipped, failed, infrastructure-error, and not-run work.
- No conclusion may claim that an AGENTS rule caused an effect unless the corresponding ablation or controlled arm supports that claim.
- The separate Herdr track requires `HERDR_ENV=1`, verified CLI syntax, isolated fixture panes, structured handoffs, and its own report rather than aggregation into single-agent metrics.
