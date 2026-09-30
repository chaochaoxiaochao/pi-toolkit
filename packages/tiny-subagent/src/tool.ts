import type { HerdrAutomation } from "./herdr.ts";
import { discoverPackageAgents } from "./personas.ts";
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

export function listText(discovery: ReturnType<typeof discoverPackageAgents>): string {
	const lines = ["Available tiny-subagent personas:"];
	if (discovery.agents.length === 0) lines.push("- (none)");
	for (const agent of discovery.agents) {
		const model = agent.model ?? "inherits current session model";
		const tools = agent.tools?.join(", ") ?? "Pi default built-in tools";
		lines.push(`- ${agent.name}: ${agent.description} (model: ${model}; tools: ${tools})`);
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
	const discovery = discoverPackageAgents(dependencies.agentsDirectory);
	if (params.action === "list") {
		return {
			content: [{ type: "text", text: listText(discovery) }],
			details: { action: "list", agents: discovery.agents, diagnostics: discovery.diagnostics },
		};
	}

	if (!params.prompt?.trim()) {
		const text = "prompt is required for execution. Use action: list to inspect available personas.";
		return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
	}

	const selectedName = params.agent?.trim() || "worker";
	const persona = discovery.agents.find((agent) => agent.name === selectedName);
	if (!persona) {
		const text = `Unknown persona '${selectedName}'.\n\n${listText(discovery)}`;
		return { content: [{ type: "text", text }], details: { errorMessage: text }, isError: true };
	}

	const explicitModel = params.model?.trim();
	const selectedModel = explicitModel || persona.model || modelId(ctx);
	const inheritThinking = !explicitModel && !persona.model ? ctx.thinkingLevel : undefined;
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
		...(inheritThinking ? { thinking: inheritThinking } : {}),
		...(persona.tools ? { tools: persona.tools } : {}),
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
