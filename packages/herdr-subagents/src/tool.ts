import type { HerdrAutomation } from "./herdr.ts";
import { loadSubagentConfiguration, type ConfigurationPaths, type SubagentConfiguration } from "./config.ts";
import { runHerdrSubagents, type HerdrSubagentsResult } from "./runner.ts";
import { runHerdrSubagentsBatch, type BatchResult, type BatchTask } from "./batch-runner.ts";
import { respondToBlockedTask } from "./blocking.ts";
import { cleanSubagentRun, historyText, listSubagentHistory, resumeHistoricalTask } from "./history.ts";
import { HERDR_ACTIONS, validateControlParams, validateRunParams } from "./validation.ts";
import type { OwnerIdentity } from "./ownership.ts";

export interface HerdrSubagentsTaskParams { name: string; prompt: string; agent?: string; model?: string; }

export interface HerdrSubagentsRunParams {
	tasks: HerdrSubagentsTaskParams[];
	label?: string;
	concurrency?: number;
	background?: boolean;
}

export interface HerdrSubagentsControlToolParams {
	action: "list" | "respond" | "history" | "resume" | "cleanup";
	runId?: string;
	answer?: string;
	task?: number;
	prompt?: string;
}

/** Internal superset used by shared execution helpers. */
export interface HerdrSubagentsToolParams {
	action?: "list" | "respond" | "history" | "resume" | "cleanup";
	prompt?: string;
	agent?: string;
	label?: string;
	model?: string;
	tasks?: HerdrSubagentsTaskParams[];
	concurrency?: number;
	background?: boolean;
	runId?: string;
	answer?: string;
	task?: number;
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
}

export type HerdrSubagentsDetails = HerdrSubagentsResult & {
	agent: string;
	description: string;
	prompt: string;
	personaPath: string;
};

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
		const model = agent.model ?? "unresolved";
		const tools = agent.tools?.join(", ") ?? "Pi default built-in tools";
		const skills = agent.skills.join(", ") || "none";
		lines.push(`- ${agent.name}: ${agent.description} (source: ${agent.source}; access: ${agent.access}; model: ${model} [${agent.modelSource}]; thinking: ${agent.thinking ?? "default"}; tools: ${tools}; skills: ${skills})`);
	}
	if (discovery.diagnostics.length > 0) {
		lines.push("", "Persona diagnostics:", ...discovery.diagnostics.map((diagnostic) => `- ${diagnostic}`));
	}
	return lines.join("\n");
}

function summaryText(result: HerdrSubagentsResult): string {
	if (result.ok) return result.output;
	const lines = [result.summary];
	if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
	if (result.recordDirectory) lines.push(`Task record: ${result.recordDirectory}`);
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
	async history({ ctx }: ToolExecutionContext) {
		const history = await listSubagentHistory(ctx.cwd);
		return { content: [{ type: "text", text: historyText(history) }], details: { action: "history", runs: history } };
	},
	async cleanup({ params, ctx }: ToolExecutionContext) {
		try {
			const cleaned = await cleanSubagentRun(ctx.cwd, params.runId as string);
			const text = cleaned ? `Removed Subagent run ${params.runId}.` : `Unknown Subagent run '${params.runId}'.`;
			return { content: [{ type: "text", text }], details: { action: "cleanup", runId: params.runId, cleaned }, ...(cleaned ? {} : { isError: true }) };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return errorResponse(text, { action: "cleanup", runId: params.runId, cleaned: false });
		}
	},
	async resume({ params, signal, onUpdate, ctx, dependencies, discovery }: ToolExecutionContext) {
		try {
			const result = await resumeHistoricalTask(ctx.cwd, params.runId as string, params.task as number, (params.prompt as string).trim(), {
				herdr: dependencies.herdr, signal, owner: dependencies.owner, stalledWarningSeconds: discovery.settings.stalledWarningSeconds,
				onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: partial.summary }], details: partial }),
				onStalled: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "resume", runId: params.runId, stalled: true } }),
				onCleanupError: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "resume", runId: params.runId, cleanupError: text } }),
			});
			return { content: [{ type: "text", text: result.summary }], details: result, ...(result.status === "failed" || result.status === "cancelled" ? { isError: true } : {}) };
		} catch (error) { return errorResponse(error instanceof Error ? error.message : String(error)); }
	},
	async respond({ params, signal, onUpdate, ctx, dependencies }: ToolExecutionContext) {
		try {
			const result = await respondToBlockedTask(ctx.cwd, (params.runId as string).trim(), (params.answer as string).trim(), {
				herdr: dependencies.herdr, taskNumber: params.task, signal, owner: dependencies.owner,
				onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: partial.summary }], details: partial }),
				onStalled: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "respond", runId: params.runId, stalled: true } }),
				onWarning: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "respond", runId: params.runId, warning: text } }),
				onCleanupError: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { action: "respond", runId: params.runId, cleanupError: text } }),
			});
			const text = [result.summary, ...(result.question ? [`Question: ${result.question}`] : []), ...result.documents.map((document) => `${document.description}: ${document.path}`)].join("\n");
			return { content: [{ type: "text", text }], details: result, ...(result.status === "failed" || result.status === "partial" || result.status === "cancelled" ? { isError: true } : {}) };
		} catch (error) { return errorResponse(error instanceof Error ? error.message : String(error)); }
	},
	async list({ discovery }: ToolExecutionContext) {
		return { content: [{ type: "text", text: listText(discovery) }], details: { action: "list", agents: discovery.personas, diagnostics: discovery.diagnostics, settings: discovery.settings } };
	},
} satisfies Record<keyof typeof HERDR_ACTIONS, ActionHandler>;

async function executeBatch({ params, signal, onUpdate, ctx, dependencies, discovery }: ToolExecutionContext): Promise<ToolResponse> {
	const tasks = params.tasks as HerdrSubagentsTaskParams[];
	const resolved: BatchTask[] = [];
	for (const task of tasks) {
		const personaName = task.agent?.trim() || "worker";
		const persona = discovery.personas.find((candidate) => candidate.name === personaName);
		if (!persona) return errorResponse(`Unknown persona '${personaName}'.\n\n${listText(discovery)}`);
		resolved.push({ name: task.name, prompt: task.prompt, agent: persona.name, access: persona.access, model: task.model?.trim() || persona.model, thinking: persona.thinking ?? (persona.modelSource === "parent session" && !task.model ? ctx.thinkingLevel : undefined), tools: persona.tools, skills: persona.skills, systemPrompt: persona.systemPrompt });
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
		const lines = [result.summary, ...result.tasks.map((task) => `- ${task.name}: ${task.status} — ${task.summary}`)];
		if (result.documents.length) lines.push("", "Documents:", ...result.documents.map((document) => `- ${document.description}: ${document.path}`));
		return { content: [{ type: "text", text: lines.join("\n") }], details: { ...result, prompts: tasks.map((task) => task.prompt) }, ...(result.ok ? {} : { isError: true }) };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		const diagnostic = error as { recordDirectory?: string; runId?: string };
		return errorResponse(text, { ...(diagnostic.recordDirectory ? { recordDirectory: diagnostic.recordDirectory } : {}), ...(diagnostic.runId ? { runId: diagnostic.runId } : {}) });
	}
}

async function executeSingle({ params, signal, onUpdate, ctx, dependencies, discovery }: ToolExecutionContext): Promise<ToolResponse> {
	const prompt = params.prompt as string;
	const selectedName = params.agent?.trim() || "worker";
	const persona = discovery.personas.find((agent) => agent.name === selectedName);
	if (!persona) return errorResponse(`Unknown persona '${selectedName}'.\n\n${listText(discovery)}`);
	const explicitModel = params.model?.trim();
	const selectedModel = explicitModel || persona.model || modelId(ctx);
	const selectedThinking = persona.thinking ?? (!explicitModel && persona.modelSource === "parent session" ? ctx.thinkingLevel : undefined);
	const details = (result: HerdrSubagentsResult): HerdrSubagentsDetails => ({ ...result, agent: persona.name, description: persona.description, prompt, personaPath: persona.filePath });
	const result = await runHerdrSubagents(prompt, {
		agent: persona.name,
		label: params.label,
		...(selectedModel ? { model: selectedModel } : {}),
		...(selectedThinking ? { thinking: selectedThinking } : {}),
		...(persona.tools ? { tools: persona.tools } : {}),
		skills: persona.skills,
		access: persona.access,
		owner: dependencies.owner,
		systemPrompt: persona.systemPrompt,
		cwd: ctx.cwd,
		signal,
		herdr: dependencies.herdr,
		stalledWarningSeconds: discovery.settings.stalledWarningSeconds,
		onStalled: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "running", stalled: true } }),
		onCleanupError: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "failed", cleanupError: text } }),
		onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: partial.summary }], details: details(partial) }),
	});
	return { content: [{ type: "text", text: summaryText(result) }], details: details(result), ...(result.ok ? {} : { isError: true }) };
}

export async function executeHerdrSubagents(
	params: HerdrSubagentsRunParams | HerdrSubagentsToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((response: ToolResponse) => void) | undefined,
	ctx: HerdrSubagentsToolContext,
	dependencies: HerdrSubagentsToolDependencies,
): Promise<ToolResponse> {
	if (params.action) return executeHerdrSubagentsControl(params as HerdrSubagentsControlToolParams, signal, onUpdate, ctx, dependencies);
	if (params.prompt && !params.tasks) {
		const discovery = loadSubagentConfiguration(ctx.cwd, dependencies.agentsDirectory, modelId(ctx), dependencies.configurationPaths);
		return executeSingle({ params, signal, onUpdate, ctx, dependencies, discovery });
	}
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
