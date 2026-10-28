---
status: accepted
---

# Ticket Sessions are full Pi sessions in a separate package, not Herdr Subagents

A Ticket Session must behave like the session the user previously opened by hand with `/new` and `/skill:implement`: it loads the user's normal extensions and skills, works in its own worktree, and can start its own subagents. A Herdr Subagent cannot do this. Its child runs with `--no-extensions --no-skills` plus a Persona allowlist, and it sets `PI_HERDR_SUBAGENTS_CHILD=1`, which prevents the child from registering `herdr_subagents` again. Therefore the Ticket Loop is a new standalone package, `@maxiaochao/pi-ticket-loop`, that calls the Herdr CLI directly. It does not import code from `@maxiaochao/pi-herdr-subagents`.

## Considered Options

- Extend `herdr-subagents` with a full-session launch mode. Rejected: it reuses the most code, but it puts a concept that is explicitly not a subagent inside the subagent package and widens that package's write-safety model.
- Extract the Herdr pane lifecycle into a shared internal module and use it from both packages. Deferred: it is the cleanest structure, but version 1 would first need a refactor of `herdr-subagents`.
- Write a minimal lifecycle in the new package. Chosen for version 1.

## Consequences

Some lifecycle code is duplicated: pane launch, the child report tool, the missed-report reminder, and tab cleanup. The rules stay aligned with Herdr Subagents (one persisted reminder, then an unconfirmed diagnostic) even though the code is separate. Upgrade trigger: when a lifecycle bug must be fixed in both packages, or when the duplicated code becomes substantial, extract the shared module.
