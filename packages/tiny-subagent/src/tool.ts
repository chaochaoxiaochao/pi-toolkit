import type { HerdrAutomation } from "./herdr.ts";
import { loadSubagentConfiguration, type ConfigurationPaths, type SubagentConfiguration } from "./config.ts";
import { runTinySubagent, type TinySubagentResult } from "./runner.ts";

export interface TinySubagentToolParams {
	action?: "list";
	prompt?: string;
	agent?: string;
	label?: string;
	model?: string;
}

export interface TinySubagentToolContext {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

export interface TinySubagentToolDependencies {
	agentsDirectory: string;
	herdr?: HerdrAutomation;
	configurationPaths?: ConfigurationPaths;
}

export type TinySubagentDetails = TinySubagentResult & {
	agent: string;
	description: string;
	prompt: string;
	personaPath: string;
};

type ToolResponse = {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
};

function modelId(ctx: TinySubagentToolContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function listText(discovery: SubagentConfiguration): string {
	const lines = ["Available tiny-subagent personas:"];
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

function summaryText(result: TinySubagentResult): string {
	if (result.ok) return result.output;
	const lines = [result.summary];
	if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
	if (result.recordDirectory) lines.push(`Task record: ${result.recordDirectory}`);
	return lines.join("\n");
}

export async function executeTinySubagent(
	params: TinySubagentToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((response: ToolResponse) => void) | undefined,
	ctx: TinySubagentToolContext,
	dependencies: TinySubagentToolDependencies,
): Promise<ToolResponse> {
	const discovery = loadSubagentConfiguration(ctx.cwd, dependencies.agentsDirectory, modelId(ctx), dependencies.configurationPaths);
	if (params.action === "list") {
		return {
			content: [{ type: "text", text: listText(discovery) }],
			details: { action: "list", agents: discovery.personas, diagnostics: discovery.diagnostics, settings: discovery.settings },
		};
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
	const details = (result: TinySubagentResult): TinySubagentDetails => ({
		...result,
		agent: persona.name,
		description: persona.description,
		prompt: params.prompt as string,
		personaPath: persona.filePath,
	});
	const result = await runTinySubagent(params.prompt, {
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
