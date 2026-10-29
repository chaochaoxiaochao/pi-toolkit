import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import { loadSubagentConfiguration, type ConfigurationPaths, type SubagentConfiguration } from "./config.ts";
import { runHerdrSubagentsBatch, type BatchResult, type BatchTask } from "./batch-runner.ts";
import { cleanSubagentRun, historyText, listSubagentHistory } from "./history.ts";
import { HERDR_ACTIONS, validateControlParams, validateRunParams } from "./validation.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { cancelActiveSubagentRuns } from "./reconcile.ts";
import { getSubagentRunStatus, runStatusText } from "./status.ts";

export interface HerdrSubagentsTaskParams { name: string; prompt: string; agent: string; model?: string; thinking?: string; }

export interface HerdrSubagentsRunParams {
	tasks: HerdrSubagentsTaskParams[];
	label?: string;
	concurrency?: number;
}

export interface HerdrSubagentsControlToolParams {
	action: "list" | "status" | "history" | "cancel" | "cleanup";
	runId?: string;
}

/** Internal superset used by shared execution helpers. */
export interface HerdrSubagentsToolParams {
	action?: "list" | "status" | "history" | "cancel" | "cleanup";
	label?: string;
	tasks?: HerdrSubagentsTaskParams[];
	concurrency?: number;
	runId?: string;
}

export interface HerdrSubagentsToolContext {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

export interface HerdrSubagentsToolDependencies {
	agentsDirectory: string;
	herdr?: HerdrAutomation;
	configurationPaths?: ConfigurationPaths;
	owner?: OwnerIdentity;
	runId?: string;
	cancelRun?: (runId: string) => Promise<{ cancelled: boolean; cleanupErrors?: string[] }>;
}

export type HerdrSubagentsBatchDetails = BatchResult & { prompts: string[] };

type ToolResponse = {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
};

function modelId(ctx: HerdrSubagentsToolContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function listText(discovery: SubagentConfiguration): string {
	const lines = ["Available Herdr Subagents personas:"];
	if (discovery.personas.length === 0) lines.push("- (none)");
	for (const agent of discovery.personas) {
		lines.push(`- ${agent.name}: ${agent.description}`);
	}
	if (discovery.diagnostics.length > 0) {
		lines.push("", "Persona diagnostics:", ...discovery.diagnostics.map((diagnostic) => `- ${diagnostic}`));
	}
	return lines.join("\n");
}

interface ToolExecutionContext {
	params: HerdrSubagentsToolParams;
	signal?: AbortSignal;
	onUpdate?: (response: ToolResponse) => void;
	ctx: HerdrSubagentsToolContext;
	dependencies: HerdrSubagentsToolDependencies;
	discovery: SubagentConfiguration;
}

type ActionHandler = (execution: ToolExecutionContext) => Promise<ToolResponse>;

const errorResponse = (text: string, details: Record<string, unknown> = {}): ToolResponse => ({
	content: [{ type: "text", text }], details: { ...details, errorMessage: text }, isError: true,
});

const actionHandlers = {
	async status({ params, ctx }: ToolExecutionContext) {
		try {
			const runId = (params.runId as string).trim();
			const status = await getSubagentRunStatus(ctx.cwd, runId);
			if (!status) return errorResponse(`Unknown Subagent run '${runId}'.`, { action: "status", runId });
			return { content: [{ type: "text", text: runStatusText(status) }], details: { action: "status", ...status } };
		} catch (error) {
			return errorResponse(error instanceof Error ? error.message : String(error), { action: "status", runId: params.runId });
		}
	},
	async history({ ctx }: ToolExecutionContext) {
		const history = await listSubagentHistory(ctx.cwd);
		return { content: [{ type: "text", text: historyText(history) }], details: { action: "history", runs: history } };
	},
	async cleanup({ params, ctx }: ToolExecutionContext) {
		try {
			const requestedRunId = params.runId as string;
			const runId = (await getSubagentRunStatus(ctx.cwd, requestedRunId))?.runId ?? requestedRunId;
			const cleaned = await cleanSubagentRun(ctx.cwd, runId);
			const text = cleaned ? `Removed Subagent run ${runId}.` : `Unknown Subagent run '${requestedRunId}'.`;
			return { content: [{ type: "text", text }], details: { action: "cleanup", runId, cleaned }, ...(cleaned ? {} : { isError: true }) };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return errorResponse(text, { action: "cleanup", runId: params.runId, cleaned: false });
		}
	},
	async cancel({ params, ctx, dependencies }: ToolExecutionContext) {
		const requestedRunId = (params.runId as string).trim();
		try {
			const runId = (await getSubagentRunStatus(ctx.cwd, requestedRunId))?.runId ?? requestedRunId;
			let result: { cancelled: boolean; cleanupErrors?: string[] };
			if (dependencies.cancelRun) result = await dependencies.cancelRun(runId);
			else {
				const reason = "Subagent run cancelled by user.";
				const cancellation = await cancelActiveSubagentRuns(ctx.cwd, dependencies.herdr ?? new CliHerdrAutomation(), { reason, owner: dependencies.owner, runId });
				result = { cancelled: cancellation.cancelledRuns > 0, cleanupErrors: cancellation.cleanupErrors };
			}
			const suffix = result.cleanupErrors?.length ? ` Cleanup warnings: ${result.cleanupErrors.join("; ")}` : "";
			const text = result.cancelled ? `Cancelled Subagent run ${runId}.${suffix}` : `Subagent run '${runId}' is not active.`;
			return { content: [{ type: "text", text }], details: { action: "cancel", runId, ...result }, ...(result.cancelled ? {} : { isError: true }) };
		} catch (error) {
			return errorResponse(error instanceof Error ? error.message : String(error), { action: "cancel", runId: requestedRunId, cancelled: false });
		}
	},
	async list({ discovery }: ToolExecutionContext) {
		return { content: [{ type: "text", text: listText(discovery) }], details: { action: "list", agents: discovery.personas, diagnostics: discovery.diagnostics, settings: discovery.settings } };
	},
} satisfies Record<keyof typeof HERDR_ACTIONS, ActionHandler>;

async function executeBatch({ params, signal, onUpdate, ctx, dependencies, discovery }: ToolExecutionContext): Promise<ToolResponse> {
	const tasks = params.tasks as HerdrSubagentsTaskParams[];
	const resolved: BatchTask[] = [];
	for (const task of tasks) {
		const personaName = task.agent.trim();
		const persona = discovery.personas.find((candidate) => candidate.name === personaName);
		if (!persona) return errorResponse(`Unknown persona '${personaName}'.\n\n${listText(discovery)}`);
		resolved.push({ name: task.name, prompt: task.prompt, agent: persona.name, access: persona.access, model: task.model?.trim() || persona.model, thinking: task.thinking?.trim() ?? persona.thinking ?? (persona.modelSource === "parent session" && !task.model ? ctx.thinkingLevel : undefined), tools: persona.tools, skills: persona.skills, extensions: persona.extensions, systemPrompt: persona.systemPrompt });
	}
	try {
		const result = await runHerdrSubagentsBatch(resolved, {
			runId: dependencies.runId,
			label: params.label?.trim() || "batch",
			concurrency: params.concurrency ?? discovery.settings.defaultConcurrency,
			maxConcurrency: discovery.settings.maxConcurrency,
			stalledWarningSeconds: discovery.settings.stalledWarningSeconds,
			cwd: ctx.cwd,
			signal,
			herdr: dependencies.herdr,
			owner: dependencies.owner,
			onCleanupError: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "batch", runId: dependencies.runId, cleanupError: text } }),
			onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: partial.summary }], details: { ...partial, prompts: tasks.map((task) => task.prompt) } }),
		});
		const lines = [result.summary];
		for (const task of result.tasks) {
			lines.push(`- ${task.name}: ${task.status} — ${task.summary}`);
			const resultDocument = task.documents[0];
			if (resultDocument) lines.push(`  Result: ${resultDocument.path}`);
		}
		const isError = result.status === "failed" || result.status === "partial" || result.status === "cancelled";
		return { content: [{ type: "text", text: lines.join("\n") }], details: { ...result, prompts: tasks.map((task) => task.prompt) }, ...(isError ? { isError: true } : {}) };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		const diagnostic = error as { recordDirectory?: string; runId?: string };
		return errorResponse(text, { ...(diagnostic.recordDirectory ? { recordDirectory: diagnostic.recordDirectory } : {}), ...(diagnostic.runId ? { runId: diagnostic.runId } : {}) });
	}
}

export async function executeHerdrSubagents(
	params: HerdrSubagentsRunParams | HerdrSubagentsToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((response: ToolResponse) => void) | undefined,
	ctx: HerdrSubagentsToolContext,
	dependencies: HerdrSubagentsToolDependencies,
): Promise<ToolResponse> {
	if (params.action) return executeHerdrSubagentsControl(params as HerdrSubagentsControlToolParams, signal, onUpdate, ctx, dependencies);
	const runParams = params as HerdrSubagentsRunParams;
	const validationError = validateRunParams(runParams);
	if (validationError) return { content: [{ type: "text", text: validationError }], details: { errorMessage: validationError }, isError: true };
	const discovery = loadSubagentConfiguration(ctx.cwd, dependencies.agentsDirectory, modelId(ctx), dependencies.configurationPaths);
	const execution = { params: runParams, signal, onUpdate, ctx, dependencies, discovery };
	return executeBatch(execution);
}

export async function executeHerdrSubagentsControl(
	params: HerdrSubagentsControlToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((response: ToolResponse) => void) | undefined,
	ctx: HerdrSubagentsToolContext,
	dependencies: HerdrSubagentsToolDependencies,
): Promise<ToolResponse> {
	const validationError = validateControlParams(params);
	if (validationError) return { content: [{ type: "text", text: validationError }], details: { errorMessage: validationError }, isError: true };
	const discovery = loadSubagentConfiguration(ctx.cwd, dependencies.agentsDirectory, modelId(ctx), dependencies.configurationPaths);
	return actionHandlers[params.action]({ params, signal, onUpdate, ctx, dependencies, discovery });
}
