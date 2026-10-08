import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resultPathForAttempt } from "../src/result-path.ts";
import { PARENT_PANE_ENV } from "../src/live-agent.ts";

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
	status: StringEnum(["completed", "needs-input", "failed"] as const, { description: "Current outcome for this task." }),
	summary: Type.String({ minLength: 1, description: "One concise paragraph for the parent agent." }),
	result: Type.String({ description: "Complete final result. Stored on disk and excluded from the parent context." }),
	documents: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ minLength: 1, description: "Path to a document produced or consulted by this task." }),
		description: Type.String({ minLength: 1, description: "Short description of the document." }),
	}))),
	error: Type.Optional(Type.String({ minLength: 1, description: "Failure detail when status is failed." })),
	question: Type.Optional(Type.String({ minLength: 1, description: "Exact question when status is needs-input." })),
});

function writeAtomic(path: string, content: string): void {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("parent", {
		description: "Return focus to the parent Agent pane",
		async handler(_args, ctx) { await returnToParent(pi, ctx); },
	});
	pi.registerShortcut(RETURN_SHORTCUT, {
		description: "Return to parent Agent",
		async handler(ctx) { await returnToParent(pi, ctx); },
	});
	pi.on("session_start", async (_event, ctx) => {
		if (process.env[PARENT_PANE_ENV]?.trim()) ctx.ui.setStatus("herdr-subagents-parent", `${RETURN_SHORTCUT} parent`);
	});
	pi.registerTool({
		name: "subagent_report",
		label: "Subagent Report",
		description: "Finish this delegated task by saving its complete result and returning only a compact structured report to the parent.",
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			const taskDirectory = process.env.PI_HERDR_SUBAGENTS_TASK_DIR?.trim();
			if (!taskDirectory) throw new Error("PI_HERDR_SUBAGENTS_TASK_DIR is not set");
			mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
			let attempt = 1;
			const task = JSON.parse(readFileSync(resolve(taskDirectory, "task.json"), "utf8")) as { attempt?: unknown };
			if (Number.isInteger(task.attempt) && Number(task.attempt) > 1) attempt = Number(task.attempt);
			const resultPath = resultPathForAttempt(taskDirectory, attempt);
			if (attempt > 1) mkdirSync(resolve(taskDirectory, "turns"), { recursive: true, mode: 0o700 });
			writeAtomic(resultPath, params.result);
			const documents = (params.documents ?? []).map((document) => ({
				path: resolve(process.cwd(), document.path),
				description: document.description,
			}));
			if (!documents.some((document) => document.path === resultPath)) {
				documents.unshift({ path: resultPath, description: "Complete task result" });
			}
			const report = {
				status: params.status,
				summary: params.summary,
				documents,
				...(params.error ? { error: params.error } : {}),
				...(params.question ? { question: params.question } : {}),
				reportedAt: new Date().toISOString(),
			};
			writeAtomic(resolve(taskDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
			return {
				content: [{ type: "text" as const, text: `${params.status}: ${params.summary}` }],
				details: report,
				terminate: true,
			};
		},
	});
}
