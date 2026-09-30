import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function installWorktree({ root = packageRoot, home = homedir() } = {}) {
  if (platform() === "win32") return [];
  const installed = [];
  const binTarget = join(home, ".local", "bin", "pi-worktree");
  mkdirSync(dirname(binTarget), { recursive: true });
  copyFileSync(join(root, "bin", "pi-worktree"), binTarget);
  chmodSync(binTarget, 0o755);
  installed.push(binTarget);

  const completionTarget = join(home, ".local", "share", "bash-completion", "completions", "pi-worktree");
  mkdirSync(dirname(completionTarget), { recursive: true });
  copyFileSync(join(root, "bin", "pi-worktree-completion.bash"), completionTarget);
  installed.push(completionTarget);
  return installed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const path of installWorktree()) console.log(`[pi-worktree] installed -> ${path}`);
}
