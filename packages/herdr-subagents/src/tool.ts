import type { HerdrAutomation } from "./herdr.ts";
import { loadSubagentConfiguration, type ConfigurationPaths, type SubagentConfiguration } from "./config.ts";
import { runHerdrSubagents, type HerdrSubagentsResult } from "./runner.ts";
import { runHerdrSubagentsBatch, type BatchResult, type BatchTask } from "./batch-runner.ts";
import { respondToBlockedTask } from "./blocking.ts";
import { cleanSubagentRun, historyText, listSubagentHistory, resumeHistoricalTask } from "./history.ts";

export interface HerdrSubagentsTaskParams { name: string; prompt: string; agent?: string; model?: string; }

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

export async function executeHerdrSubagents(
	params: HerdrSubagentsToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((response: ToolResponse) => void) | undefined,
	ctx: HerdrSubagentsToolContext,
	dependencies: HerdrSubagentsToolDependencies,
): Promise<ToolResponse> {
	const discovery = loadSubagentConfiguration(ctx.cwd, dependencies.agentsDirectory, modelId(ctx), dependencies.configurationPaths);
	if (params.action === "history") {
		const history = await listSubagentHistory(ctx.cwd);
		return { content: [{ type: "text", text: historyText(history) }], details: { action: "history", runs: history } };
	}
	if (params.action === "cleanup") {
		const cleaned = params.runId ? await cleanSubagentRun(ctx.cwd, params.runId) : false;
		const text = cleaned ? `Removed Subagent run ${params.runId}.` : `Unknown Subagent run '${params.runId ?? ""}'.`;
		return { content: [{ type: "text", text }], details: { action: "cleanup", runId: params.runId, cleaned }, ...(cleaned ? {} : { isError: true }) };
	}
	if (params.action === "resume") {
		if (!params.runId || !params.task || !params.prompt?.trim()) {
			const text = "runId, task, and prompt are required to resume historical work.";
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
		try {
			const result = await resumeHistoricalTask(ctx.cwd, params.runId, params.task, params.prompt.trim(), dependencies.herdr);
			return { content: [{ type: "text", text: result.summary }], details: result, ...(result.status === "failed" ? { isError: true } : {}) };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
	}
	if (params.action === "respond") {
		if (!params.runId?.trim() || !params.answer?.trim()) {
			const text = "runId and answer are required to respond to a blocked task.";
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
		try {
			const result = await respondToBlockedTask(ctx.cwd, params.runId.trim(), params.answer.trim(), dependencies.herdr, params.task);
			const text = [result.summary, ...(result.question ? [`Question: ${result.question}`] : []), ...result.documents.map((document) => `${document.description}: ${document.path}`)].join("\n");
			return { content: [{ type: "text", text }], details: result, ...(result.status === "failed" || result.status === "partial" ? { isError: true } : {}) };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
	}
	if (params.action === "list") {
		return {
			content: [{ type: "text", text: listText(discovery) }],
			details: { action: "list", agents: discovery.personas, diagnostics: discovery.diagnostics, settings: discovery.settings },
		};
	}

	if (params.tasks) {
		if (params.tasks.length === 0) {
			const text = "tasks must contain at least one task.";
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
		const resolved: BatchTask[] = [];
		for (const task of params.tasks) {
			const personaName = task.agent?.trim() || "worker";
			const persona = discovery.personas.find((candidate) => candidate.name === personaName);
			if (!persona) {
				const text = `Unknown persona '${personaName}'.\n\n${listText(discovery)}`;
				return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
			}
			resolved.push({ name: task.name, prompt: task.prompt, agent: persona.name, access: persona.access, model: task.model?.trim() || persona.model, thinking: persona.thinking ?? (persona.modelSource === "parent session" && !task.model ? ctx.thinkingLevel : undefined), tools: persona.tools, skills: persona.skills, systemPrompt: persona.systemPrompt });
		}
		try {
			const result = await runHerdrSubagentsBatch(resolved, {
				runId: params.runId,
				label: params.label?.trim() || "batch",
				concurrency: params.concurrency ?? discovery.settings.defaultConcurrency,
				maxConcurrency: discovery.settings.maxConcurrency,
				stalledWarningSeconds: discovery.settings.stalledWarningSeconds,
				cwd: ctx.cwd,
				signal,
				herdr: dependencies.herdr,
				onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: partial.summary }], details: { ...partial, prompts: params.tasks?.map((task) => task.prompt) ?? [] } }),
			});
			const lines = [result.summary, ...result.tasks.map((task) => `- ${task.name}: ${task.status} — ${task.summary}`)];
			if (result.documents.length) lines.push("", "Documents:", ...result.documents.map((document) => `- ${document.description}: ${document.path}`));
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ...result, prompts: params.tasks.map((task) => task.prompt) }, ...(result.ok ? {} : { isError: true }) };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
		}
	}

	if (!params.prompt?.trim()) {
		const text = "prompt is required for execution. Use action: list to inspect available personas.";
		return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
	}

	const selectedName = params.agent?.trim() || "worker";
	const persona = discovery.personas.find((agent) => agent.name === selectedName);
	if (!persona) {
		const text = `Unknown persona '${selectedName}'.\n\n${listText(discovery)}`;
		return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
	}

	const explicitModel = params.model?.trim();
	const selectedModel = explicitModel || persona.model || modelId(ctx);
	const selectedThinking = persona.thinking ?? (!explicitModel && persona.modelSource === "parent session" ? ctx.thinkingLevel : undefined);
	const details = (result: HerdrSubagentsResult): HerdrSubagentsDetails => ({
		...result,
		agent: persona.name,
		description: persona.description,
		prompt: params.prompt as string,
		personaPath: persona.filePath,
	});
	const result = await runHerdrSubagents(params.prompt, {
		agent: persona.name,
		label: params.label,
		...(selectedModel ? { model: selectedModel } : {}),
		...(selectedThinking ? { thinking: selectedThinking } : {}),
		...(persona.tools ? { tools: persona.tools } : {}),
		skills: persona.skills,
		access: persona.access,
		systemPrompt: persona.systemPrompt,
		cwd: ctx.cwd,
		signal,
		herdr: dependencies.herdr,
		onUpdate: (partial) => onUpdate?.({
			content: [{ type: "text", text: partial.summary }],
			details: details(partial),
		}),
	});
	return {
		content: [{ type: "text", text: summaryText(result) }],
		details: details(result),
		...(result.ok ? {} : { isError: true }),
	};
}
