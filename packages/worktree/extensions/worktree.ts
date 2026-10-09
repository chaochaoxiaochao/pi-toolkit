import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CLI_PATH = fileURLToPath(new URL("../bin/pi-worktree", import.meta.url));

export const WORKTREE_SWITCH_REQUEST = "pi-worktree/switch-request";

export interface WorktreePrepareResult {
  status: "created" | "attached" | "reused" | "already-active";
  path: string;
  branch: string;
  dirty: boolean;
}

export interface WorktreeSwitchRequest extends WorktreePrepareResult {
  kind: typeof WORKTREE_SWITCH_REQUEST;
  version: 1;
  action: "fork-and-switch";
  sessionFile: string;
}

const SwitchRequestSchema = Type.Object({
  kind: Type.Literal(WORKTREE_SWITCH_REQUEST),
  version: Type.Literal(1),
  action: Type.Literal("fork-and-switch"),
  sessionFile: Type.String(),
  status: Type.Union([
    Type.Literal("created"),
    Type.Literal("attached"),
    Type.Literal("reused"),
    Type.Literal("already-active"),
  ]),
  path: Type.String(),
  branch: Type.String(),
  dirty: Type.Boolean(),
});

function parseCommandArgs(input: string): { name: string; base?: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "start" || tokens.length < 2) {
    throw new Error("用法：/worktree start <name> [--base <ref>]");
  }

  const name = tokens[1];
  let base: string | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    if (tokens[index] !== "--base" || !tokens[index + 1] || base !== undefined) {
      throw new Error("用法：/worktree start <name> [--base <ref>]");
    }
    base = tokens[index + 1];
    index += 1;
  }
  return { name, base };
}

function parsePrepareOutput(stdout: string): WorktreePrepareResult {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("pi-worktree prepare 没有返回结果");
  const result = JSON.parse(line) as Partial<WorktreePrepareResult>;
  if (
    !["created", "attached", "reused", "already-active"].includes(String(result.status))
    || typeof result.path !== "string"
    || typeof result.branch !== "string"
    || typeof result.dirty !== "boolean"
  ) {
    throw new Error("pi-worktree prepare 返回了无效结果");
  }
  return result as WorktreePrepareResult;
}

async function prepareWorktree(
  pi: ExtensionAPI,
  cwd: string,
  name: string,
  base?: string,
): Promise<WorktreePrepareResult> {
  const args = ["prepare", "--json"];
  if (base) args.push("--base", base);
  args.push(name);
  const result = await pi.exec(CLI_PATH, args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `pi-worktree prepare 失败（退出码 ${result.code}）`);
  }
  return parsePrepareOutput(result.stdout);
}

export default function worktreeExtension(pi: ExtensionAPI) {
  pi.registerCommand("worktree", {
    description: "创建或复用 worktree，并在当前界面切换过去",
    handler: async (input, ctx) => {
      let prepared: WorktreePrepareResult;
      let targetSessionFile: string;
      try {
        const { name, base } = parseCommandArgs(input);
        const sourceSessionFile = ctx.sessionManager.getSessionFile();
        if (!sourceSessionFile) {
          throw new Error("当前是临时会话；请启用 session 持久化后再切换 worktree");
        }

        await ctx.waitForIdle();
        prepared = await prepareWorktree(pi, ctx.cwd, name, base);
        if (resolve(ctx.cwd) === resolve(prepared.path)) {
          ctx.ui.notify(`已经位于 worktree：${prepared.path}`, "info");
          return;
        }

        const target = SessionManager.forkFrom(sourceSessionFile, prepared.path);
        targetSessionFile = target.getSessionFile() ?? "";
        if (!targetSessionFile) throw new Error("无法为 worktree 创建持久会话");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      // Do not catch replacement errors here: switchSession may already have
      // invalidated this command context, so Pi must report such failures.
      const switched = await ctx.switchSession(targetSessionFile, {
        withSession: async (next) => {
          const dirtyNote = prepared.dirty ? "（已有未提交改动）" : "";
          next.ui.notify(`已切换到 ${prepared.branch}：${prepared.path}${dirtyNote}`, "success");
        },
      });
      if (switched.cancelled) {
        try {
          unlinkSync(targetSessionFile);
        } catch (error) {
          ctx.ui.notify(`worktree 会话切换已取消，但无法清理派生会话：${error instanceof Error ? error.message : String(error)}`, "warning");
          return;
        }
        ctx.ui.notify("worktree 会话切换已取消", "warning");
      }
    },
  });

  pi.registerTool({
    name: "enter_worktree",
    label: "Enter Worktree",
    exposure: "model-only",
    description:
      "Create or reuse an isolated git worktree and request that the host Harness move this current conversation into it. Call this tool alone, then stop; the Harness performs the session switch after the tool completes.",
    parameters: Type.Object({
      name: Type.String({ description: "Single-segment worktree and branch name" }),
      base: Type.Optional(Type.String({ description: "Optional git ref used only when creating a new branch" })),
    }),
    outputSchema: SwitchRequestSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sourceSessionFile = ctx.sessionManager.getSessionFile();
      if (!sourceSessionFile) throw new Error("当前是临时会话，Harness 无法续接到 worktree");

      const prepared = await prepareWorktree(pi, ctx.cwd, params.name, params.base);
      const request: WorktreeSwitchRequest = {
        kind: WORKTREE_SWITCH_REQUEST,
        version: 1,
        action: "fork-and-switch",
        sessionFile: sourceSessionFile,
        ...prepared,
      };
      const dirtyNote = prepared.dirty ? " 目标 worktree 已有未提交改动。" : "";
      return {
        content: [{
          type: "text",
          text: `Worktree ${prepared.status}: ${prepared.path}.${dirtyNote} 已请求 Harness 将当前会话切换到该目录；不要继续调用仓库工具。`,
        }],
        details: request,
        structuredContent: request,
        terminate: true,
      };
    },
  });
}
