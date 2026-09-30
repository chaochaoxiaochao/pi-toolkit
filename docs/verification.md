# Package split verification

Last run: 2026-09-30

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
- Codex Edit: 12 parser, matcher, routing, and package tests passed.
- Herdr Subagents: 81 scheduler, recovery, schema, navigation, persona, and process-boundary tests passed. A real Herdr smoke completed two concurrent interactive Pi Agents in distinct panes and confirmed their shared run tab closed after settlement.
- Todo, BTW, Worktree installer, and Worktree CLI integration tests passed.
- Media: all five screenshots are non-empty; Cache Export is a full-page 1440 × 2278 capture; all five GIFs contain three distinct frames.

Open [`package-media-gallery.html`](package-media-gallery.html) to inspect every generated PNG and GIF in one page.
