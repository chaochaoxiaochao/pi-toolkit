# @maxiaochao/pi-codex-edit

A Pi extension that exposes Codex-style `apply_patch` for GPT/Codex models and keeps Pi's native `edit` tool for other models.

## Install

```bash
pi install npm:@maxiaochao/pi-codex-edit
```

The package registers `apply_patch` and selects the editing tool from the resolved model configuration:

- GPT/Codex model with OpenAI grammar support: `apply_patch`
- Other models: Pi's native `edit`

The package does not add a permanent AGENTS rule telling models not to use `apply_patch`. Only the selected editor tool is active, so the model receives one editing protocol.

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

The package defaults to the GPT/Codex model allowlist in `config.json`. The route additionally requires:

```text
model.api = openai-responses or openai-codex-responses
model.compat.supportsOpenAIGrammarTools = true
```

Edit `config.json` in the installed package only if you need to change the default allowlist. The package's current implementation keeps both tools registered for session replay and changes only the active tool set on `session_start` and `model_select`.

## Documentation

- `summary.md`: benchmark summary and decision record.
- `codex-edit-explainer.html`: self-contained interactive architecture and configuration explainer.

The benchmark found equal final correctness in the fair 20-case comparison, with first editor-call success improving from 85% to 95%. Overall tool-call count and cache-inclusive token use were effectively unchanged, so this package should be rolled out first to GPT/Codex model scopes rather than treated as a universal replacement.
