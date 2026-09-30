# Codex Edit (apply_patch)

A Pi extension bundled with `@maxiaochao/pi-toolkit` that exposes Codex-style `apply_patch` for GPT/Codex models and keeps Pi's native `edit` tool for other models.

## Install

Bundled with the toolkit; install or update the root package and the extension comes along:

```bash
pi install npm:@maxiaochao/pi-toolkit
pi update npm:@maxiaochao/pi-toolkit
```

The extension registers `apply_patch` and selects the editing tool from the resolved model configuration:

- Allowlisted GPT/Codex model: `apply_patch`
- Other models: Pi's native `edit`

The default allowlist enables all `gpt-5.6-*` models regardless of provider. Other model families can be added after separate validation by editing `config.json`.

The extension does not add a permanent AGENTS rule telling models not to use `apply_patch`. Only the selected editor tool is active, so the model receives one editing protocol.

## What `apply_patch` does

The tool accepts raw Codex patch text between `*** Begin Patch` and `*** End Patch`. It supports:

- `Add File`
- `Delete File`
- `Update File`
- `Move to`
- multiple update hunks with `@@` context
- EOF-oriented insertions

Before writing, it parses the complete patch, resolves paths, rejects workspace escapes and unsafe symlink/parent paths, reads all source files, and computes every update in memory. Only after preflight succeeds does it mutate files. It returns per-file diff details and reports committed paths if a later filesystem operation fails.

## Configuration

The extension defaults to a model-ID allowlist in `config.json`: `"gpt-5.6-*"`. Provider does not affect routing. Each entry is a `*` glob, so this matches every `gpt-5.6-` variant. The route additionally requires:

```text
model.api = openai-responses or openai-codex-responses
```

Grammar support is not part of the route. When a provider does not emit Lark grammar tools, Pi falls back to a normal function tool, so `apply_patch` still runs there — only the grammar-enforced output shape is lost.

Edit `extensions/codex-edit/config.json` inside the installed `@maxiaochao/pi-toolkit` package only if you need to change the default allowlist. The implementation keeps both tools registered for session replay and changes only the active tool set on `session_start` and `model_select`.

## Documentation

- `summary.md`: benchmark summary and decision record.
- `codex-edit-explainer.html`: self-contained interactive architecture and configuration explainer.

The benchmark found equal final correctness in the fair 20-case comparison, with first editor-call success improving from 85% to 95%. Overall tool-call count and cache-inclusive token use were effectively unchanged, so the route stays limited to the GPT/Codex allowlist rather than replacing `edit` universally.
