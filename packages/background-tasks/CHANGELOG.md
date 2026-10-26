# Changelog

## 2026-10-26 - v0.1.2

- restrict background tasks to model-only and use concise automatic-notification guidance
- Fix `background_task` exposure to `model-only`; reject Codemode and other nested callers without adding a configuration file.
- Use concise English startup guidance emphasizing automatic notification without sleep or polling.

## 2026-10-22 - v0.1.1

- batch unread completions at tool boundaries, preserve interrupted runs, and provide non-polling startup guidance
- Include the approved non-polling startup guidance in the tool description, model-visible start result and Codemode's structured result. Keep ordinary output reads separate from waiting.
- Follow OMP's user-interrupt semantics: retain pending and later results without restarting the stopped agent, then hand unread results to the next user-message run. Do not confuse manual-compaction cancellation with an agent interrupt; add no switch or waiting tool.
- Cover direct native tool batches as well as Codemode, and real user interrupts before/after shell completion. Determine native compaction cancellation from lifecycle state instead of error wording.
- Deliver pending completions together after the current tool batch, before the next model request, instead of queuing one follow-up turn per task after the final report. Idle completions still wake the main agent automatically.
- Consume pending reminders when tool callers read terminal output, show actual completion times, and clear pending notification timers on session changes. Keep process/subagent execution and global queue settings unchanged; add no notification pause switch.
- Add a real-Pi four-completion queue regression with direct nested/Codemode reads, alongside deterministic busy/idle, consumption and abort/error checks.
- Back off busy-session notification checks through 1/2/4/8/16/30-second intervals, capped at 30 seconds without a retry limit or unread-result expiry. Tool boundaries still deliver immediately; fresh batches reset the delay. Keep the generic idle check instead of subscribing to individual busy-operation events.
- Verify native Pi manual compaction success, summary failure and cancellation with real shell jobs finishing during an offline summary request; pending results wake the main agent once after compaction, without another user prompt.

## 2026-10-20 - v0.1.0

- bundle background shell tasks with runtime limits, bounded logs, completion notifications and /bg controls
- Bundle and enable this package in the complete toolkit by default while retaining standalone installation as an alternative.

- Add session-scoped background shell tasks with two concurrent slots, finite runtime limits, private bounded logs, Bash-aligned output views, and explicit cancellation.
- Add completion followUps, `/bg` controls, and an above-editor widget with five-second finished rows. Reuse Pi's native shell backend without subagents or extra system-prompt rules.
