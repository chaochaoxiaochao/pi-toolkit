import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultsPath = fileURLToPath(new URL("../config.json", import.meta.url));

async function readSettings(path, required = false) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!required && error.code === "ENOENT") return {};
    throw new Error(`Codex Edit config ${path}: ${error.message}`, { cause: error });
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    if ((required || "enabled" in value) && typeof value.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    if ((required || "models" in value) && (!Array.isArray(value.models)
      || !value.models.every((pattern) => typeof pattern === "string" && pattern.trim().length > 0))) {
      throw new Error("models must be an array of non-empty strings");
    }
    return {
      ...("enabled" in value ? { enabled: value.enabled } : {}),
      ...("models" in value ? { models: value.models } : {}),
    };
  } catch (error) {
    throw new Error(`Codex Edit config ${path}: ${error.message}`, { cause: error });
  }
}

export async function loadSettings(agentDir) {
  const defaults = await readSettings(defaultsPath, true);
  const user = await readSettings(join(agentDir, "codex-edit.json"));
  return { ...defaults, ...user };
}
