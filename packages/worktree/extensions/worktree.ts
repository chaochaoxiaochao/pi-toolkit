import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CLI_PATH = fileURLToPath(new URL("../bin/pi-worktree", import.meta.url));
const PENDING_SWITCH_ARGUMENT = "__enter_worktree_pending__";

export interface WorktreePrepareResult {
  status: "created" | "attached" | "reused" | "already-active";
  path: string;
  branch: string;
  dirty: boolean;
}

export interface EnterWorktreeResult extends WorktreePrepareResult {
  switch: "scheduled" | "already-active";
}

const EnterWorktreeResultSchema = Type.Object({
  switch: Type.Union([Type.Literal("scheduled"), Type.Literal("already-active")]),
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
  signal?: AbortSignal,
): Promise<WorktreePrepareResult> {
  const args = ["prepare", "--json"];
  if (base) args.push("--base", base);
  args.push(name);
  const result = await pi.exec(CLI_PATH, args, { cwd, signal });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `pi-worktree prepare 失败（退出码 ${result.code}）`);
  }
  if (signal?.aborted) throw new Error("worktree 创建已取消");
  return parsePrepareOutput(result.stdout);
}

export default function worktreeExtension(pi: ExtensionAPI) {
  let pendingSwitch: WorktreePrepareResult | undefined;
  let pendingDispatchScheduled = false;
  let transitionReserved = false;

  pi.on("agent_settled", event => {
    if (!pendingSwitch || pendingDispatchScheduled) return;
    if (event.aborted) {
      pendingSwitch = undefined;
      pendingDispatchScheduled = false;
      transitionReserved = false;
      return;
    }
    pendingDispatchScheduled = true;
    // AgentSession defers prompts submitted from agent_settled until the event
    // finishes. Command expansion then supplies a safe command context with
    // switchSession(), after the tool result is persisted and the run is idle.
    pi.sendUserMessage(`/worktree ${PENDING_SWITCH_ARGUMENT}`, {
      expandPromptTemplates: true,
    });
  });

  pi.registerCommand("worktree", {
    description: "创建或复用 worktree，并在当前界面切换过去",
    handler: async (input, ctx) => {
      const isPendingSwitch = input.trim() === PENDING_SWITCH_ARGUMENT;
      let prepared: WorktreePrepareResult;
      let targetSessionFile: string;
      try {
        if (!isPendingSwitch && transitionReserved) {
          ctx.ui.notify("Agent 正在切换 worktree，请等待切换完成后再执行 /worktree。", "warning");
          return;
        }
        if (!isPendingSwitch) transitionReserved = true;
        const requestedSwitch = isPendingSwitch ? pendingSwitch : undefined;
        if (isPendingSwitch && !requestedSwitch) {
          throw new Error("没有待处理的 Agent worktree 切换");
        }
        const sourceSessionFile = ctx.sessionManager.getSessionFile();
        if (!sourceSessionFile) {
          throw new Error("当前是临时会话；请启用 session 持久化后再切换 worktree");
        }

        await ctx.waitForIdle();
        if (requestedSwitch) {
          prepared = requestedSwitch;
        } else {
          const { name, base } = parseCommandArgs(input);
          prepared = await prepareWorktree(pi, ctx.cwd, name, base);
        }
        if (resolve(ctx.cwd) === resolve(prepared.path)) {
          if (isPendingSwitch) {
            pendingSwitch = undefined;
            pendingDispatchScheduled = false;
          }
          transitionReserved = false;
          ctx.ui.notify(`已经位于 worktree：${prepared.path}`, "info");
          return;
        }

        const sessionDir = ctx.sessionManager.usesDefaultSessionDir()
          ? undefined
          : ctx.sessionManager.getSessionDir();
        const target = SessionManager.forkFrom(sourceSessionFile, prepared.path, sessionDir);
        targetSessionFile = target.getSessionFile() ?? "";
        if (!targetSessionFile) throw new Error("无法为 worktree 创建持久会话");
      } catch (error) {
        if (isPendingSwitch) pendingSwitch = undefined;
        pendingDispatchScheduled = false;
        transitionReserved = false;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      // Do not catch replacement errors here: switchSession may already have
      // invalidated this command context, so Pi must report such failures.
      let switched: { cancelled: boolean };
      try {
        switched = await ctx.switchSession(targetSessionFile, {
          withSession: async (next) => {
            const dirtyNote = prepared.dirty ? "（已有未提交改动）" : "";
            next.ui.notify(`已切换到 ${prepared.branch}：${prepared.path}${dirtyNote}`, "info");
          },
        });
      } catch (error) {
        pendingSwitch = undefined;
        pendingDispatchScheduled = false;
        transitionReserved = false;
        throw error;
      }
      pendingSwitch = undefined;
      pendingDispatchScheduled = false;
      transitionReserved = false;
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
    executionMode: "sequential",
    description:
      "Create or reuse an isolated git worktree, then automatically move this current conversation into it after the current Agent run settles. Call this tool alone and do not call repository tools afterward.",
    parameters: Type.Object({
      name: Type.String({ description: "Single-segment worktree and branch name" }),
      base: Type.Optional(Type.String({ description: "Optional git ref used only when creating a new branch" })),
    }),
    outputSchema: EnterWorktreeResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.sessionManager.getSessionFile()) {
        throw new Error("当前是临时会话，无法续接到 worktree");
      }
      if (transitionReserved) {
        const target = pendingSwitch ? `：${pendingSwitch.path}` : "";
        throw new Error(`已有 worktree 切换正在处理${target}`);
      }
      transitionReserved = true;

      let prepared: WorktreePrepareResult;
      try {
        prepared = await prepareWorktree(pi, ctx.cwd, params.name, params.base, signal);
        if (signal.aborted) throw new Error("worktree 创建已取消");
      } catch (error) {
        transitionReserved = false;
        throw error;
      }
      const alreadyActive = resolve(ctx.cwd) === resolve(prepared.path);
      const result: EnterWorktreeResult = {
        switch: alreadyActive ? "already-active" : "scheduled",
        ...prepared,
      };
      if (alreadyActive) transitionReserved = false;
      else pendingSwitch = prepared;
      const dirtyNote = prepared.dirty ? " 目标 worktree 已有未提交改动。" : "";
      return {
        content: [{
          type: "text",
          text: alreadyActive
            ? `已经位于 worktree：${prepared.path}.${dirtyNote}`
            : `Worktree ${prepared.status}: ${prepared.path}.${dirtyNote} 当前 Agent run 结束后会自动切换到该目录；不要继续调用仓库工具。`,
        }],
        details: result,
        structuredContent: result,
        terminate: true,
      };
    },
  });
}
