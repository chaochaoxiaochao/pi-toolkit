# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Project-specific instructions override this file when they conflict.

## 1. Think Before Coding

**Surface tradeoffs. Name confusion instead of resolving it silently.**

- State your material assumptions explicitly.
- If multiple interpretations exist, present them rather than picking one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If requirements conflict (durability vs latency, correctness vs speed), name the conflict explicitly. Never average conflicting requirements into something that satisfies neither.
- When unresolved ambiguity would materially change the result, ask. When no human is reachable (headless, async, subagent), choose the interpretation you can defend, state it as an assumption, and proceed under Rule 4.

## 2. Simplicity First

**YAGNI cuts what you don't need; KISS keeps what remains simple.**

- Build what was asked, for the callers that exist today.
- Introduce an abstraction after repeated use reveals a stable concept.
- For states excluded by enforced invariants, fail visibly instead of inventing fallback behavior.
- Each function you write does one thing. If it runs past a couple of screens or nests past three levels, review whether splitting it improves clarity.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

The test: every changed line traces to the user's request, or to a defect that request reveals.

- Match existing style, even if you'd do it differently.
- Remove imports, variables, and functions that YOUR changes made unused. Leave pre-existing dead code in place and mention it.

When fixing a bug, fix the root cause, not the symptom. Find where the defect actually lives:
- Find every statically discoverable caller and relevant implementation; a report names a symptom, and patching only the path the ticket mentions leaves sibling callers still broken.
- If the shared function is wrong, fix it once - do not scatter per-caller guards. Name the sibling callers the fix now affects.
- If one caller is wrong, fix that caller - do not add defensive handling to a correct shared function.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"
- "Make X fast" -> "Write and test a simple reference implementation, then optimize against its results"

For multi-step or materially ambiguous tasks, state a brief plan where every step carries its own check:
1. [Step] -> verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Read Before You Write

**Understand adjacent code before changing it. "Looks orthogonal" is a dangerous assumption.**

Before changing a file:
- Read the file's exports and public API.
- Read the immediate callers of the function you're modifying.

## 6. Fail Visibly, Not Silently

**Silent skips are failures.**

- "Completed" is wrong if anything was silently skipped.
- "Tests pass" is wrong if any required test was skipped or not run.
- If a required input, file, or tool is missing (or a step is impossible under the stated constraints), do NOT fabricate it to make a check pass. Report what is missing and what you need.

## 7. Reuse Before Writing

**Before writing new code, check in order:**
1. Reuse an existing project abstraction when it encodes project semantics. (If it is itself the bug, fix it once - see Rule 3.)
2. Otherwise use the standard library or a direct dependency already declared by the project.
3. Only then write it yourself.
