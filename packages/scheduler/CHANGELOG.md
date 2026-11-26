## 2026-11-26 - v0.2.0

- Simplify schedule controls, remove manual trigger, add argument completion, and allow ID-free single cancellation
- Simplify the Agent tool description and document each parameter directly in its schema.
- Remove manual `trigger`; schedules now run only at their configured interval.
- Add `/schedule` subcommand and cancellation-ID completion.
- Allow `cancel` without an ID when exactly one schedule is active.

## 2026-11-17 - v0.1.2

- Add a 20-second default interval for shorthand prompts
- Add `/schedule <prompt>` with a 20-second interval. Keep explicit intervals and existing management commands.

## 2026-10-09 - v0.1.1

- add clear-all controls and multi-line widget coexistence
- Add `clear` to the Agent tool and `/schedule clear` for stopping every active schedule.
- Replace the compact footer status with an above-editor multi-line widget that shows one row per schedule and coexists with the below-editor Herdr Fleet.

## 2026-10-09 - v0.1.0

- add session-scoped interval prompts with Agent and user controls
- Add session-scoped interval prompts controlled by both the Agent tool and `/schedule` command.
- Add manual trigger, cancellation, missed-tick coalescing, and lightweight TUI status.
