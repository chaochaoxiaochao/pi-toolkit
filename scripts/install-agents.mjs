// postinstall hook: sync the bundled global AGENTS.md and seed the default theme
// without overriding a theme the user has already selected.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(homedir(), ".pi", "agent");
const bundled = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "global", "AGENTS.md"), "utf8");
const agentsTarget = join(agentDir, "AGENTS.md");
const settingsTarget = join(agentDir, "settings.json");

if (!existsSync(agentsTarget) || readFileSync(agentsTarget, "utf8") !== bundled) {
  mkdirSync(dirname(agentsTarget), { recursive: true });
  writeFileSync(agentsTarget, bundled, "utf8");
  console.log("[pi-toolkit] global AGENTS.md synced ->", agentsTarget);
}

function writeSettings(settings) {
  mkdirSync(dirname(settingsTarget), { recursive: true });
  writeFileSync(settingsTarget, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

if (!existsSync(settingsTarget)) {
  writeSettings({ theme: "nightowl" });
  console.log("[pi-toolkit] default theme set -> nightowl");
} else {
  try {
    const settings = JSON.parse(readFileSync(settingsTarget, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("settings.json must contain a JSON object");
    }

    const record = settings;
    if (typeof record.theme !== "string" || record.theme.length === 0) {
      record.theme = "nightowl";
      writeSettings(record);
      console.log("[pi-toolkit] default theme set -> nightowl");
    }
  } catch (error) {
    console.warn("[pi-toolkit] could not set default theme:", error instanceof Error ? error.message : String(error));
  }
}
