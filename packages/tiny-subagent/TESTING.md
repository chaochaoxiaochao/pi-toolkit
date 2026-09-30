# Tiny Subagent test strategy

## Flow

1. `npm --prefix packages/tiny-subagent test` runs deterministic process and persona tests.
2. `pi -ne -ns --no-session -e ./packages/tiny-subagent/extensions/tiny-subagent.ts` verifies extension loading.
3. `npm pack ./packages/tiny-subagent --dry-run` verifies package contents.
4. Verify the README example and the production-runner media `docs/screenshot.png` and `docs/demo.gif` are present in the tarball.

## Cases

- Resolve package-local personas and validate frontmatter.
- Start an isolated child Pi process with selected model and tools.
- Stream child activity while keeping it outside the parent conversation.
- Preserve detailed process/protocol failures and oversized artifacts.
- Render collapsed and expanded tool output.

## Latest baseline

All deterministic child-process and persona cases pass. Release validation also requires the extension load check.
