# pi-toolkit

Personal Pi toolkit with the `/todos` todo extension and `/cache_export` interactive prompt-cache dashboard.

## Install

Install the root package to enable the toolkit extensions globally:

```bash
pi install npm:@maxiaochao/pi-toolkit
```

The package postinstall hook also synchronizes the bundled global instructions to:

```text
~/.pi/agent/AGENTS.md
```

That global file is loaded by Pi across projects. When `global/AGENTS.md` changes, publish a new `@maxiaochao/pi-toolkit` version and update installed copies:

```bash
pi update npm:@maxiaochao/pi-toolkit
```

To synchronize the file directly from a checkout instead:

```bash
bash scripts/install.sh
```

## Tiny Subagent

The tiny subagent is a separate npm package. Install it independently when you want the `tiny_subagents` tool:

```bash
pi install npm:@maxiaochao/pi-tiny-subagent
```

It is not included in the root package's `pi.extensions` list. The two packages have independent versions, release tags, and update commands:

```bash
pi update npm:@maxiaochao/pi-toolkit
pi update npm:@maxiaochao/pi-tiny-subagent
```

See [packages/tiny-subagent/README.md](packages/tiny-subagent/README.md) for personas, model selection, child isolation, live transcript rendering, and diagnostics.

## Development

Repository development and release rules are documented in [AGENTS.md](AGENTS.md).
