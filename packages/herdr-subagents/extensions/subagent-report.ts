import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resultPathForAttemptId } from "../src/result-path.ts";
import { PARENT_PANE_ENV } from "../src/live-agent.ts";
import { attemptReportPath, attemptStatePath, requireAttemptId, type AttemptState } from "../src/attempts.ts";

const RETURN_SHORTCUT = "alt+p";

async function returnToParent(pi: ExtensionAPI, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
	const parentPaneId = process.env[PARENT_PANE_ENV]?.trim();
	if (!parentPaneId) {
		ctx.ui.notify("Parent Agent pane is unavailable for this Subagent session.", "error");
		return;
	}
	const result = await pi.exec("herdr", ["agent", "focus", parentPaneId]);
	if (result.code !== 0) {
		ctx.ui.notify(`Could not return to the parent Agent: ${result.stderr.trim() || result.stdout.trim() || `Herdr exited ${result.code}`}`, "error");
	}
}

const ReportParams = Type.Object({
	status: StringEnum(["completed", "failed"] as const, { description: "Terminal task outcome. completed: the task is finished. failed: the task cannot be completed." }),
	summary: Type.String({ minLength: 1, description: "One concise paragraph for the parent agent." }),
	result: Type.String({ description: "Complete final result. Stored on disk and excluded from the parent context." }),
	documents: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ minLength: 1, description: "Path to a document produced or consulted by this task." }),
		description: Type.String({ minLength: 1, description: "Short description of the document." }),
	}))),
	error: Type.Optional(Type.String({ minLength: 1, description: "Failure detail when status is failed." })),
});

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

function currentAttemptId(taskDirectory: string): string {
	const task = JSON.parse(readFileSync(resolve(taskDirectory, "task.json"), "utf8")) as { currentAttemptId?: unknown };
	return requireAttemptId(task.currentAttemptId);
}

function writeAttemptState(taskDirectory: string, attemptId: string, state: AttemptState): void {
	writeAtomic(attemptStatePath(taskDirectory, attemptId), `${JSON.stringify({ attemptId, state, at: new Date().toISOString() }, null, 2)}\n`);
}

let herdrReportSeq = Date.now() * 1000;

function reportHerdrState(state: "working" | "blocked" | "idle", message?: string): void {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const socket = net.createConnection(endpoint);
	socket.on("error", () => undefined);
	socket.on("connect", () => socket.end(`${JSON.stringify({ id: `herdr:subagent:${Date.now()}:${Math.random().toString(36).slice(2)}`, method: "pane.report_agent", params: { pane_id: paneId, source: "herdr:pi", agent: "pi", state, message, seq: ++herdrReportSeq } })}\n`));
}

export default function (pi: ExtensionAPI) {
	let activeAttemptId: string | undefined;
	let blockedCount = 0;
	pi.on("before_agent_start", async () => {
		const taskDirectory = process.env.PI_HERDR_SUBAGENTS_TASK_DIR?.trim();
		if (!taskDirectory) return;
		activeAttemptId = currentAttemptId(taskDirectory);
		writeAttemptState(taskDirectory, activeAttemptId, "working");
	});
	pi.on("agent_start", () => reportHerdrState("working"));
	pi.on("agent_settled", (_event, ctx) => {
		const taskDirectory = process.env.PI_HERDR_SUBAGENTS_TASK_DIR?.trim();
		if (taskDirectory && activeAttemptId) {
			writeAttemptState(taskDirectory, activeAttemptId, "settled");
		}
		// Keep the interactive child alive at Pi's final automatic-work boundary.
		// The orchestrator settles each task from its atomic report. Once every task in
		// the run settles, it closes the owned tab immediately when unfocused or waits
		// for the user to leave it. Force-exiting here can interrupt TUI restoration.
		if (ctx?.isIdle?.() === true) reportHerdrState("idle");
	});
	pi.events.on("herdr:blocked", (data: { active?: boolean; label?: string }) => {
		blockedCount = Math.max(0, blockedCount + (data?.active ? 1 : -1));
		reportHerdrState(blockedCount > 0 ? "blocked" : "working", blockedCount > 0 ? data?.label : undefined);
	});
	pi.registerCommand("parent", {
		description: "Return focus to the parent Agent pane",
		async handler(_args, ctx) { await returnToParent(pi, ctx); },
	});
	pi.registerShortcut(RETURN_SHORTCUT, {
		description: "Return to parent Agent",
		async handler(ctx) { await returnToParent(pi, ctx); },
	});
	pi.on("session_start", async (_event, ctx) => {
		// Remove the legacy hint on reload without touching editor/plugin status.
		ctx.ui.setStatus("herdr-subagents-parent", undefined);
	});
	pi.registerTool({
		name: "subagent_report",
		label: "Subagent Report",
		description: "Finish this delegated task by saving its complete result and returning only a compact structured report to the parent.",
		parameters: ReportParams,
		renderCall(params, theme) {
			const resultBytes = Buffer.byteLength(params.result, "utf8");
			const size = resultBytes < 1024 ? `${resultBytes} B` : `${(resultBytes / 1024).toFixed(1)} KiB`;
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_report "))}${theme.fg(params.status === "completed" ? "success" : "error", params.status)}${theme.fg("dim", ` · ${size} saved to disk`)}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Saving report..."), 0, 0);
			const report = result.details as { status?: string; summary?: string; documents?: Array<{ path?: string }> } | undefined;
			const resultPath = report?.documents?.[0]?.path;
			const status = report?.status ?? "saved";
			const summary = report?.summary?.replaceAll("\n", " ") ?? "Report saved.";
			return new Text(`${theme.fg(status === "completed" ? "success" : status === "failed" ? "error" : "accent", status)}${theme.fg("dim", ` · ${summary}${resultPath ? `\n${resultPath}` : ""}`)}`, 0, 0);
		},
		async execute(_toolCallId, params) {
			const taskDirectory = process.env.PI_HERDR_SUBAGENTS_TASK_DIR?.trim();
			if (!taskDirectory) throw new Error("PI_HERDR_SUBAGENTS_TASK_DIR is not set");
			const attemptId = activeAttemptId ?? currentAttemptId(taskDirectory);
			mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
			const resultPath = resultPathForAttemptId(taskDirectory, attemptId);
			const reportPath = attemptReportPath(taskDirectory, attemptId);
			const documents = (params.documents ?? []).map((document) => ({
				path: resolve(process.cwd(), document.path),
				description: document.description,
			}));
			if (!documents.some((document) => document.path === resultPath)) {
				documents.unshift({ path: resultPath, description: "Complete task result" });
			}
			const report = {
				attemptId,
				status: params.status,
				summary: params.summary,
				documents,
				...(params.error ? { error: params.error } : {}),
				reportedAt: new Date().toISOString(),
			};
			if (existsSync(reportPath)) {
				const existing = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
				const comparable = ({ reportedAt: _reportedAt, ...value }: Record<string, unknown>) => value;
				const sameReport = JSON.stringify(comparable(existing)) === JSON.stringify(comparable(report));
				const sameResult = existsSync(resultPath) && readFileSync(resultPath, "utf8") === params.result;
				if (!sameReport || !sameResult) throw new Error("Conflicting subagent_report already exists for this task.");
			} else {
				writeAtomic(resultPath, params.result);
				writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
			}
			return {
				content: [{ type: "text" as const, text: `${params.status}: ${params.summary}` }],
				details: report,
				terminate: true,
			};
		},
	});
}
