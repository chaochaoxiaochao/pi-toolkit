# Testing Claude Cage

Run in `packages/claude-cage`:

```sh
npm test
npm run load-test
npm run test:upstream
npm pack --dry-run
```

`npm test` covers local Unix sockets, fragmented frames, cancellation, EOF, deadlines, session cleanup, cached model discovery, complete tool turns, install confirmation, preamble bounds and no automatic duplicate requests in a real isolated Pi with retry enabled. The installed-upstream case is skipped **unless an installation is supplied**. `test:upstream` runs that case explicitly: it installs to a temporary HOME, tests systemd socket activation with a fake CLI and loopback model server, and checks that setup refuses foreign installations. Needs network for pinned dependency downloads or populated offline caches (see `guest/SETUP.md`). It does not read real Claude credentials.

For the **explicit real VM acceptance** use an already-running Wired profile. The mock model never contacts Anthropic. All fixture files are temporary guest files. No user service is installed. Example:

```sh
CAGE_TEST_EXECUTABLE=/absolute/path/to/cage CAGE_TEST_CONFIG=/absolute/path/to/config.json npm run test:wired
```

From the repository root `node scripts/capture-package-media.mjs claude-cage` renders the fixture status and two-turn tool exchange. Real login, subscription charging and the user-installed service’s egress cannot be verified by those fixtures. Check the intended account and egress before a separately authorized live model test.
