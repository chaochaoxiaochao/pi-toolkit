# AGENTS.md

Project-specific instructions override this file when they conflict.

## 1. Clear Output

- Use ASD-STE100-inspired principles: short sentences, one idea per sentence, and consistent terms. Apply its formal language rules only to English.
- When it improves understanding, use a diagram, HTML artifact, or video instead of long prose.

## 2. Think Before Coding

- Surface material assumptions, interpretations, and tradeoffs.
- If unresolved ambiguity would materially change the result, ask. When no human is reachable, choose a defensible interpretation, state it, and proceed with verifiable criteria.
- Surface conflicting requirements before choosing an approach.

## 3. Minimal Solution

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

## 4. Skill Boundaries

After loading a skill, use its documented interface for normal tasks.

Inspect its implementation, installed executable, or package source only when:

- The user asks to review, debug, or modify it.
- Its documented behavior conflicts with observed behavior.
- Required usage details are missing from the skill.

## 5. Read, Then Change Surgically

Before editing, read the affected public API and its immediate callers. For a bug, find every statically discoverable caller and relevant implementation.

Every changed line traces to the user's request or to a defect that request reveals.

- Match existing style.
- Remove imports, variables, and functions that your changes make unused. Leave pre-existing dead code in place and mention it.
- Fix a faulty shared function once and name affected sibling callers; if only one caller is wrong, fix that caller instead of guarding a correct shared function.

## 6. Completion and Verification

For changed behavior, run a check that distinguishes the expected result from the failure. Report what passed, what was not verified, and any blockers.

## 7. Frontend Verification

For frontend feature development, load the `web-browser` skill and verify the result in a real Chrome browser through CDP. Exercise the relevant user flow with real clicks, capture screenshots of the resulting UI, and test the actual behavior before reporting completion.

## 8. Worktree Isolation

For a Git-repository task that changes more than one module, or implements a feature intended for release, ask before editing whether to isolate it in a worktree. Skip the question when already in a linked worktree.

## 9. Anti-Sycophancy

Treat confirmation cues such as “对吧？”, “是不是？”, or “right?” as open hypotheses. Verify the premise against code, facts, and architecture before agreeing. Open with the verdict and its evidence: if the premise is false or the approach is suboptimal, say so in the first sentence, then give the reason and tradeoffs.
