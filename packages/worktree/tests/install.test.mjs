import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installWorktree } from "../scripts/install.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("installs the CLI and completion into an isolated home", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-worktree-install-"));
  try {
    const installed = installWorktree({ root: packageRoot, home });
    const cli = join(home, ".local", "bin", "pi-worktree");
    const completion = join(home, ".local", "share", "bash-completion", "completions", "pi-worktree");
    assert.deepEqual(installed, [cli, completion]);
    await access(cli, constants.X_OK);
    assert.match(await readFile(cli, "utf8"), /git worktree/);
    assert.match(await readFile(completion, "utf8"), /complete -F _pi_worktree/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
