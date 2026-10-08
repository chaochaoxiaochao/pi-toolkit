# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Project-specific instructions override this file when they conflict.

## 1. Think Before Coding

- Surface material assumptions, interpretations, and tradeoffs.
- If unresolved ambiguity would materially change the result, ask. When no human is reachable, choose a defensible interpretation, state it, and proceed with verifiable criteria.
- Prefer the simpler approach. Name conflicting requirements rather than silently compromising between them.

## 2. Minimal Solution

Understand the problem and relevant code flow before choosing the first rung that works:

1. Skip functionality that is speculative or was not requested.
2. Reuse an existing project abstraction when it encodes the required semantics.
3. Otherwise use the standard library or a native platform feature.
4. Otherwise use a direct dependency already declared by the project.
5. Only then write the minimum custom code that works.

- Introduce abstractions only after repeated use reveals a stable concept.
- Prefer boring, focused code; review long or deeply nested functions for splitting.
- Never simplify away explicit requirements, trust-boundary validation, data-loss protection, security, or accessibility.
- For states excluded by enforced invariants, fail visibly instead of inventing fallback behavior.
- State the ceiling and upgrade trigger of any deliberate simplification that cuts a real corner.

## 3. Read, Then Change Surgically

Before editing, read the affected public API and its immediate callers. For a bug, find every statically discoverable caller and relevant implementation.

Every changed line traces to the user's request or to a defect that request reveals.

- Match existing style.
- Remove imports, variables, and functions that your changes make unused. Leave pre-existing dead code in place and mention it.
- Fix a faulty shared function once and name affected sibling callers; if only one caller is wrong, fix that caller instead of guarding a correct shared function.

## 4. Goal-Driven Execution

- Turn work into checkable outcomes: reproduce bugs before fixing them, preserve behavior during refactors, and optimize against a tested reference implementation.
- For multi-step or materially ambiguous work, state a brief plan and give every step its own verification.
- Leave the smallest relevant runnable check for new or changed non-trivial logic. Do not introduce a test framework solely for that check.

## 5. Fail Visibly

- "Completed" is wrong if anything required was silently skipped.
- "Tests pass" is wrong if any required test was skipped or not run.
- If a required input, file, or tool is missing, or a step is impossible under the stated constraints, report what is missing and what you need. Never fabricate it to make a check pass.

## 6. Worktree Isolation

For a Git-repository task that coordinates substantial changes across multiple files or modules, or implements a feature intended for release, ask before editing whether to isolate it in a worktree. Skip the question when already in a linked worktree.

If the user agrees, read the `pi-worktree` skill and establish the worktree before changing code. When no human is reachable, create a worktree only when the task explicitly requests one.