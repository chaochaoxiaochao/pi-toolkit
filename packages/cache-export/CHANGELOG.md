# Changelog

## 2026-10-23 - v0.1.1

- correct request timing, usage scope and historical cache evidence
- Keep mixed historical TTLs and partial one-hour writes unknown at request scope; a one-hour subset must not override mixed-policy evidence.

- Show main-request usage separately from completed cache-warm, compaction, and other auxiliary usage.
- Use message timestamps and response durations; remove universal TTL and inferred expiry propagation. Retention references are historical observations, never server expiry measurements.
- Track context edits, label segment cumulative rates, and show unreported reasoning as Unknown without plotting zero.
- Persist allowlisted cache parameters and model-policy references without prompts, cache keys, headers, URLs, or credentials.
- Resolve relative export paths against the session cwd; add deterministic, native Pi, and real Chrome regressions.

## 2026-09-30 - v0.1.0

- 从 `@maxiaochao/pi-toolkit` 提取 cache export 权威源码，支持主包捆绑和独立安装。
