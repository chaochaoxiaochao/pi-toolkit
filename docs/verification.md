# Package split verification

Last run: 2026-10-08

This report covers the root bundle and the five independently releasable packages after the package split. Raw command output is stored locally under `.cache/verification/` and is intentionally ignored by Git.

## Required checks

| Check | Expected result |
|---|---|
| `node scripts/capture-package-media.mjs` | Regenerates ten real-output media files; each GIF has three distinct frames. |
| `npm test` | Root layout, BTW, Todo, all child deterministic tests, Cache Export Chromium E2E, Worktree installer, and CLI integration pass. |
| `npm run load-test` | Every configured extension entrypoint loads successfully. |
| `npm pack ./packages/<slug> --dry-run` | Each child tarball contains its runtime, documentation, screenshot, and demo. |
| `npm pack --dry-run` | The root bundle contains root-only assets and the child runtime sources referenced by its manifest. |
| `git diff --check` | No whitespace errors. |

## Baseline results

- Cache Export: 47 deterministic assertions and 18 Chromium E2E assertions passed, with 0 failures and 0 skips.
- Codex Edit: 22 Node tests and 12 shared comparison cases passed, including real Pi native-edit versus local Codex Edit, released versus local parser, deterministic report regeneration, and outside-workspace safety comparisons.
- Herdr Subagents: 133 scheduler, recovery, schema, navigation, persona, and process-boundary tests passed. A real Herdr smoke completed two concurrent interactive Pi Agents in distinct panes, kept the focused shared tab open through settlement, and automatically closed it after focus moved away. Deterministic extension coverage also verifies blocked dispatcher/Fleet ownership, parent-shutdown cleanup, malformed-report repair, and deferred cleanup notifications.
- Todo, BTW, Worktree installer, and Worktree CLI integration tests passed.
- Media: all five screenshots are non-empty; Cache Export is a full-page 1440 × 2278 capture; Herdr Subagents is a live parent-Pi and three-pane Agent recording, while the other four GIFs contain three distinct frames.

Open [`package-media-gallery.html`](package-media-gallery.html) to inspect every generated PNG and GIF in one page.
