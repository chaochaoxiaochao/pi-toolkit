// postinstall hook: sync the bundled global AGENTS.md to ~/.pi/agent/AGENTS.md
// (pi's native global context file). Idempotent: writes only when different.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundled = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "global", "AGENTS.md"), "utf8");
const target = join(homedir(), ".pi", "agent", "AGENTS.md");

if (!existsSync(target) || readFileSync(target, "utf8") !== bundled) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bundled, "utf8");
  console.log("[pi-toolkit] global AGENTS.md synced ->", target);
}
