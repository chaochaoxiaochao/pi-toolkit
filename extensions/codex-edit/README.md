# Codex Edit in pi-toolkit

`@maxiaochao/pi-toolkit` bundles and loads Codex Edit by default through `index.ts`.
The canonical implementation and configuration live in [`packages/codex-edit`](../../packages/codex-edit), which is also published independently as `@maxiaochao/pi-codex-edit` for users who only want this extension.

Install either the full toolkit or the standalone package. Installing both is unnecessary and may register `apply_patch` twice.

`pi update npm:@maxiaochao/pi-toolkit` updates this bundled copy after a new toolkit version has been published. Publishing only `@maxiaochao/pi-codex-edit` does not update toolkit installations.
