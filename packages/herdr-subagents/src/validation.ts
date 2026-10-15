import type { HerdrSubagentsControlToolParams, HerdrSubagentsRunParams } from "./tool.ts";

export const HERDR_ACTIONS = {
	list: { allowed: ["action"], includeRunId: false },
	history: { allowed: ["action"], includeRunId: false },
	status: { allowed: ["action", "runId"], includeRunId: true },
	cancel: { allowed: ["action", "runId"], includeRunId: true },
	cleanup: { allowed: ["action", "runId"], includeRunId: true },
} as const satisfies Record<string, { allowed: readonly (keyof HerdrSubagentsControlToolParams)[]; includeRunId: boolean }>;

export function validateRunParams(params: HerdrSubagentsRunParams): string | undefined {
	if (!params.tasks?.length) return "Provide a non-empty tasks list.";
	for (const [index, task] of params.tasks.entries()) {
		if (typeof task.agent !== "string" || !task.agent.trim()) return `tasks[${index}].agent is required; select a Persona explicitly (use herdr_subagents_control action=list).`;
	}
	return undefined;
}

export function validateControlParams(params: HerdrSubagentsControlToolParams): string | undefined {
	const allowed = HERDR_ACTIONS[params.action]?.allowed;
	if (!allowed) return "Provide a valid control action.";
	const extra = Object.keys(params).find((key) => !allowed.includes(key as keyof HerdrSubagentsControlToolParams));
	if (extra) return `Field '${extra}' is not valid with action '${params.action}'.`;
	if ((params.action === "status" || params.action === "cancel" || params.action === "cleanup") && !params.runId?.trim()) return `runId is required for action '${params.action}'.`;
	return undefined;
}
