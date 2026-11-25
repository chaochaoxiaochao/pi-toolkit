## 2026-11-25 - v0.3.0

- Integrate Pi cache warming and cap upstream cache breakpoints at four
- Integrate with Pi's CacheWarmer using verified adaptive-thinking model metadata and one-hour retention.
- Let real Cage turns and status, model-discovery, or setup commands cancel and preempt low-priority warming requests on the single guest connection.
- Keep unsafe models out of warming, preserve cache usage entries, and document the authorized real A/W/B/C acceptance with no observed #34 signature.
- Pin the exact head of upstream PR #41 so replay requests never exceed Anthropic's four `cache_control` blocks. Add the eight-shape installed-upstream regression and verify the previously failing warm system-prompt update through the real Cage route.

## 2026-11-24 - v0.2.0

- Replace the socket daemon with one persistent bounded stdio connection per Pi runtime, transcript append synchronization, and fail-closed v1 migration
- Replace the shared socket-activated guest daemon and per-request client with one lazy, persistent stdio service per Pi runtime.
- Add bounded 256 MiB framing, backpressured writes, compact delta streaming, 20-minute turns, transcript full/append synchronization, and fatal `/reload` diagnostics.
- Migrate profiles from `clientPath` to `servicePath`; confirmed setup automatically replaces an exact marker-owned v1 installation and removes its old systemd files.

## 2026-11-24 - v0.1.1

- Diagram the host and guest architecture, explain pinned adapter upgrades, and remove the pdlog listing from the toolkit README without changing the skill.

## 2026-11-24 - v0.1.0

- Add an optional Claude Cage provider with host Pi tools, a socket-activated guest worker, and Herdr Persona setup.
- Add an opt-in host Pi provider and socket-activated guest worker using a pinned pi-claude-code adapter.
