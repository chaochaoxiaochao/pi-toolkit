---
status: accepted
---

# Replace generic Todo CRUD with execution-plan lifecycle commands

Todo represents a branch-local Execution Plan, not an independently editable task collection. Generic `add`, `update`, `remove`, and `clear` operations allowed models to reorder lifecycle state indirectly, complete non-current work, reuse stale IDs, or erase the history needed for users and branch reconstruction. The model-facing protocol therefore exposes only `plan`, `add_step`, `complete_current`, `cancel_current`, and `list`. `plan` is the explicit direction-change boundary; it closes unfinished prior work while preserving Plan History and allocates fresh monotonic IDs. Completion and cancellation require the expected current ID, fail atomically on stale state, and advance exactly one step.

## Consequences

The extension serializes all calls that share mutable plan state. Every result reports one canonical Current Plan with stable IDs and statuses, while `/todos` is the only full-history view. The widget derives contiguous display positions from live Current Plan state and never exposes internal IDs or closed history. Arbitrary update, remove, clear, undo, batch completion, and marker-text interpretation are intentionally absent. A changed direction requires `plan`; a blocked but still necessary step remains current; cancellation means only that the current step is no longer needed and the later plan is still valid.
