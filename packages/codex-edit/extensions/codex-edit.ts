import { access, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  APPLY_PATCH_LARK_GRAMMAR,
  applyUpdate,
  parsePatch,
  resolveWorkspacePath,
} from "../src/parser.ts";

const editorToolNames = new Set(["edit", "apply_patch"]);
const settingsUrl = new URL("../config.json", import.meta.url);

async function loadSettings() {
  try {
    return JSON.parse(await readFile(settingsUrl, "utf8"));
  } catch {
    return { enabled: true, models: [] };
  }
}

function globMatches(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function modelIsAllowed(model, settings) {
  if (!settings.enabled || !model) return false;
  if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
  if (model.compat?.supportsOpenAIGrammarTools !== true) return false;
  return (settings.models || []).some((entry) =>
    globMatches(model.provider, entry.provider) && globMatches(model.id, entry.model),
  );
}

function syncEditorTools(pi, ctx, model, settings) {
  const active = pi.getActiveTools();
  if (!active.some((name) => editorToolNames.has(name))) return;
  const selected = modelIsAllowed(model, settings) ? "apply_patch" : "edit";
  const next = active.filter((name) => !editorToolNames.has(name));
  next.push(selected);
  pi.setActiveTools([...new Set(next)]);
  if (ctx.hasUI) ctx.ui.setStatus("codex-edit", `editor: ${selected}`);
}

async function fileInfo(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
    throw new Error(`${label} is unavailable (${code})`);
  }
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  await access(path, constants.R_OK | constants.W_OK);
  return info;
}

async function ensureParentIsSafe(path, workspace) {
  let current = dirname(path);
  while (current !== workspace && current.startsWith(`${workspace}/`)) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Parent path is a symbolic link: ${current}`);
      if (!info.isDirectory()) throw new Error(`Parent path is not a directory: ${current}`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      throw error;
    }
    current = dirname(current);
  }
  if (current !== workspace) throw new Error(`Parent path escapes workspace: ${path}`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function withPathQueues(paths, fn) {
  const ordered = [...new Set(paths)].sort();
  async function acquire(index) {
    if (index === ordered.length) return fn();
    return withFileMutationQueue(ordered[index], () => acquire(index + 1));
  }
  return acquire(0);
}

function buildFileDetail(path, action, before, after, moveTo) {
  const diff = generateDiffString(before, after);
  const patch = generateUnifiedPatch(path, before, after);
  return { path, action, moveTo, diff: diff.diff, patch, firstChangedLine: diff.firstChangedLine };
}

export default async function (pi) {
  const settings = await loadSettings();

  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description: "Apply a Codex-style patch. This is a FREEFORM tool, so provide raw patch text and never wrap it in JSON or a Markdown fence.",
    promptSnippet: "Apply Codex-style freeform patches to add, delete, update, or move files",
    promptGuidelines: [
      "Use apply_patch for file changes and provide raw text between *** Begin Patch and *** End Patch.",
      "Do not wrap apply_patch input in JSON or a Markdown code fence.",
    ],
    parameters: Type.Object({
      patch: Type.String({ description: "Raw Codex-style patch text" }),
    }),
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    },
    executionMode: "sequential",
    async execute(_toolCallId, { patch }, signal, _onUpdate, ctx) {
      const operations = parsePatch(patch);
      const resolved = [];
      const targets = [];
      for (const operation of operations) {
        const source = resolveWorkspacePath(ctx.cwd, operation.path);
        const destination = operation.moveTo ? resolveWorkspacePath(ctx.cwd, operation.moveTo) : undefined;
        targets.push(source, ...(destination ? [destination] : []));
        resolved.push({ ...operation, source, destination });
      }
      if (new Set(targets).size !== targets.length) throw new Error("Multiple patch operations target the same resolved path");

      const committed = [];
      return withPathQueues(targets, async () => {
        const prepared = [];
        for (const operation of resolved) {
          if (signal?.aborted) throw new Error("Operation aborted");
          await ensureParentIsSafe(operation.source, ctx.cwd);
          if (operation.destination) await ensureParentIsSafe(operation.destination, ctx.cwd);
          if (operation.action === "add") {
            if (await pathExists(operation.source)) throw new Error(`Cannot add existing file ${operation.path}`);
            prepared.push({ ...operation, before: "", after: operation.content });
          } else {
            await fileInfo(operation.source, `Source file ${operation.path}`);
            const before = await readFile(operation.source, "utf8");
            const after = operation.action === "delete" ? "" : applyUpdate(before, operation.chunks, operation.path);
            if (operation.destination && await pathExists(operation.destination)) {
              throw new Error(`Cannot move over existing file ${operation.moveTo}`);
            }
            prepared.push({ ...operation, before, after });
          }
        }

        for (const operation of prepared) {
          if (signal?.aborted) throw new Error("Operation aborted");
          if (operation.action === "add") {
            await mkdir(dirname(operation.source), { recursive: true });
            await writeFile(operation.source, operation.after, "utf8");
          } else if (operation.action === "delete") {
            await unlink(operation.source);
          } else if (operation.destination) {
            await mkdir(dirname(operation.destination), { recursive: true });
            await writeFile(operation.destination, operation.after, "utf8");
            await unlink(operation.source);
          } else {
            await writeFile(operation.source, operation.after, "utf8");
          }
          committed.push(operation);
        }

        const files = committed.map((operation) => buildFileDetail(
          operation.path,
          operation.destination ? "move" : operation.action,
          operation.before,
          operation.after,
          operation.moveTo,
        ));
        return {
          content: [{ type: "text", text: `Applied ${committed.length} file operation(s): ${committed.map((operation) => operation.path).join(", ")}` }],
          details: {
            files,
            committedPaths: committed.map((operation) => operation.path),
            exact: true,
            combinedPatch: files.map((file) => file.patch).join("\n"),
          },
        };
      }).catch((error) => {
        const prefix = committed.length ? ` Committed before failure: ${committed.map((operation) => operation.path).join(", ")}.` : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${prefix}`);
      });
    },
    renderCall(args, theme, context) {
      const component = context.lastComponent || new Text("", 0, 0);
      const patch = typeof args?.patch === "string" ? args.patch : "";
      const files = [...patch.matchAll(/\*\*\* (?:Add|Delete|Update) File: ([^\n]+)/g)].map((match) => match[1]);
      component.setText(theme.fg("toolTitle", "apply_patch") + theme.fg("muted", files.length ? ` ${files.join(", ")}` : " patch"));
      return component;
    },
    renderResult(result, options, theme, context) {
      const details = result?.details;
      const component = context.lastComponent || new Text("", 0, 0);
      if (context.isError) {
        component.setText(theme.fg("error", result?.content?.map((item) => item.text || "").join("\n") || "apply_patch failed"));
        return component;
      }
      const files = details?.files || [];
      let text = theme.fg("success", `Applied ${files.length} file operation(s)`);
      if (options.expanded) {
        for (const file of files) {
          text += `\n${theme.fg("toolTitle", file.action)} ${file.path}`;
          if (file.diff) text += `\n${theme.fg("dim", file.diff)}`;
        }
      }
      component.setText(text);
      return component;
    },
  });

  pi.on("session_start", (_event, ctx) => syncEditorTools(pi, ctx, ctx.model, settings));
  pi.on("model_select", (event, ctx) => syncEditorTools(pi, ctx, event.model, settings));
}
