# Changelog

## 2026-10-20 - v0.1.0

- bundle background shell tasks with runtime limits, bounded logs, completion notifications and /bg controls
- Bundle and enable this package in the complete toolkit by default while retaining standalone installation as an alternative.

- Add session-scoped background shell tasks with two concurrent slots, finite runtime limits, private bounded logs, Bash-aligned output views, and explicit cancellation.
- Add completion followUps, `/bg` controls, and an above-editor widget with five-second finished rows. Reuse Pi's native shell backend without subagents or extra system-prompt rules.
