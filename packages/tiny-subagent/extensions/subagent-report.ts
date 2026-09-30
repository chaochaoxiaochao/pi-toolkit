import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ReportParams = Type.Object({
	status: StringEnum(["completed", "failed"] as const, { description: "Terminal outcome for this task." }),
	summary: Type.String({ minLength: 1, description: "One concise paragraph for the parent agent." }),
	result: Type.String({ description: "Complete final result. Stored on disk and excluded from the parent context." }),
	documents: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ minLength: 1, description: "Path to a document produced or consulted by this task." }),
		description: Type.String({ minLength: 1, description: "Short description of the document." }),
	}))),
	error: Type.Optional(Type.String({ minLength: 1, description: "Failure detail when status is failed." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_report",
		label: "Subagent Report",
		description: "Finish this delegated task by saving its complete result and returning only a compact structured report to the parent.",
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			const taskDirectory = process.env.PI_TINY_SUBAGENT_TASK_DIR?.trim();
			if (!taskDirectory) throw new Error("PI_TINY_SUBAGENT_TASK_DIR is not set");
			mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
			const resultPath = resolve(taskDirectory, "result.md");
			writeFileSync(resultPath, params.result, { encoding: "utf8", mode: 0o600 });
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
				reportedAt: new Date().toISOString(),
			};
			writeFileSync(resolve(taskDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			return {
				content: [{ type: "text" as const, text: `${params.status}: ${params.summary}` }],
				details: report,
				terminate: true,
			};
		},
	});
}
