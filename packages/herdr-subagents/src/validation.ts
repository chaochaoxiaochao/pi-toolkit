import type { HerdrSubagentsToolParams } from "./tool.ts";

const executionFields = ["prompt", "agent", "label", "model", "tasks", "concurrency", "background"] as const;

export const HERDR_ACTIONS = {
	list: { allowed: ["action"], includeRunId: false },
	history: { allowed: ["action"], includeRunId: false },
	cleanup: { allowed: ["action", "runId"], includeRunId: true },
	respond: { allowed: ["action", "runId", "answer", "task"], includeRunId: true },
	resume: { allowed: ["action", "runId", "task", "prompt"], includeRunId: true },
} as const satisfies Record<string, { allowed: readonly (keyof HerdrSubagentsToolParams)[]; includeRunId: boolean }>;

export function validateToolParams(params: HerdrSubagentsToolParams): string | undefined {
	const present = (key: keyof HerdrSubagentsToolParams) => params[key] !== undefined;
	const extraField = (allowed: readonly (keyof HerdrSubagentsToolParams)[]) => Object.keys(params).find((key) => !allowed.includes(key as keyof HerdrSubagentsToolParams));
	if (params.action) {
		const extra = extraField(HERDR_ACTIONS[params.action].allowed);
		if (extra) return `Field '${extra}' is not valid with action '${params.action}'.`;
		if (params.action === "cleanup" && !params.runId?.trim()) return "runId is required for action 'cleanup'.";
		if (params.action === "respond" && (!params.runId?.trim() || !params.answer?.trim())) return "runId and answer are required for action 'respond'.";
		if (params.action === "resume" && (!params.runId?.trim() || !params.task || !params.prompt?.trim())) return "runId, task, and prompt are required for action 'resume'.";
		return undefined;
	}
	if (params.prompt && params.tasks) return "Provide either prompt or tasks, not both.";
	if (params.prompt) {
		const extra = extraField(["prompt", "agent", "label", "model"]);
		if (extra) return `Field '${extra}' is not valid for single-task execution.`;
		return undefined;
	}
	if (params.tasks) {
		if (!params.tasks.length) return "tasks must contain at least one task.";
		const extra = extraField(["tasks", "label", "concurrency", "background"]);
		if (extra) return `Field '${extra}' is not valid for batch execution.`;
		return undefined;
	}
	const supplied = executionFields.find((key) => present(key));
	return supplied ? `Field '${supplied}' requires prompt or tasks.` : "Provide an action, prompt, or non-empty tasks list.";
}
