import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverPackageAgents } from "../src/personas.ts";
import { runTinySubagent, type TinySubagentResult } from "../src/runner.ts";

const ACTIONS = ["list"] as const;
const TinySubagentParams = Type.Union([
	Type.Object({
		action: StringEnum(ACTIONS, { description: "Discover package-local personas before execution." }),
	}),
	Type.Object({
		prompt: Type.String({ minLength: 1, description: "One focused prompt for the subagent." }),
		agent: Type.Optional(Type.String({ minLength: 1, description: "Persona name selected from action=list. Defaults to worker." })),
		model: Type.Optional(Type.String({ minLength: 1, description: "Optional Pi model, for example provider/model:high." })),
	}),
]);

type ToolParams = {
	action?: "list";
	prompt?: string;
	agent?: string;
	model?: string;
};

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

function modelId(ctx: { model?: { provider: string; id: string } }): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function listText(discovery: ReturnType<typeof discoverPackageAgents>): string {
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

function errorText(result: TinySubagentResult): string {
	const lines = ["Tiny subagent failed."];
	if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
	if (result.stopReason) lines.push(`Stop reason: ${result.stopReason}`);
	if (result.exitCode !== null) lines.push(`Exit code: ${result.exitCode}`);
	if (result.signal) lines.push(`Signal: ${result.signal}`);
	if (result.stderr.trim()) lines.push(`stderr:\n${result.stderr.trim()}`);
	if (result.protocolErrors.length > 0) lines.push(`Protocol errors:\n${result.protocolErrors.join("\n")}`);
	if (result.output.trim()) lines.push(`Output before failure:\n${result.output.trim()}`);
	if (result.artifacts) lines.push(`Full output artifacts: ${result.artifacts.directory}`);
	return lines.join("\n");
}

function renderSummary(result: TinySubagentResult): string {
 const text = result.ok ? result.output || "(no output)" : errorText(result);
 if (!result.ok || !result.artifacts) return text;
 return `${text}\n\nFull output artifacts: ${result.artifacts.directory}`;
}

type TinySubagentDetails = TinySubagentResult & {
 agent: string;
 description: string;
 systemPrompt: string;
 prompt: string;
 personaPath: string;
};

function messageText(message: TinySubagentDetails["messages"][number]): string {
 if (typeof message.content === "string") return message.content;
 if (!Array.isArray(message.content)) return "";
 return message.content
  .filter((part) => part.type === "text" && typeof part.text === "string")
  .map((part) => part.text as string)
  .join("");
}

function messageLines(message: TinySubagentDetails["messages"][number]): string[] {
 if (message.role === "user") return [];
 if (message.role === "assistant" && Array.isArray(message.content)) {
  return message.content.flatMap((part) => {
   if (part.type === "toolCall") {
    const args = part.arguments === undefined ? "" : ` ${JSON.stringify(part.arguments)}`;
    return [`→ ${part.name ?? "tool"}${args}`];
   }
   if (part.type === "text" && typeof part.text === "string") return [`assistant: ${part.text}`];
   return [];
  });
 }
 if (message.role === "toolResult") {
  const prefix = `← ${message.toolName ?? "tool"}${message.isError ? " [error]" : ""}`;
  const text = messageText(message);
  return [prefix, ...(text ? text.split("\n").map((line) => `  ${line}`) : [])];
 }
 const text = messageText(message);
 return text ? [`${message.role ?? "message"}: ${text}`] : [];
}

function latestActivity(messages: TinySubagentDetails["messages"]): string {
 const lines = messages.flatMap(messageLines);
 return lines.length > 0 ? lines[lines.length - 1] : "starting child Pi...";
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.registerTool({
		name: "tiny_subagents",
		label: "Tiny Subagent",
		description: "Delegate one focused task to a package-local persona in a fresh Pi context. Supports persona discovery with action=list and execution with agent, prompt, and an optional model override. No parent conversation or extensions are inherited.",
		promptSnippet: "Run one focused task through a package-local tiny subagent persona",
		promptGuidelines: ["Before execution, call tiny_subagents with action 'list' once and choose an executable persona by name or description. After receiving the list, do not list again; omit action and run one focused prompt with the selected agent."],
		parameters: TinySubagentParams,

		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const discovery = discoverPackageAgents(packageAgentsDir);
			if (params.action === "list") {
				return {
					content: [{ type: "text" as const, text: listText(discovery) }],
					details: { action: "list", agents: discovery.agents, diagnostics: discovery.diagnostics },
				};
			}

			if (!params.prompt?.trim()) {
				const text = "prompt is required for execution. Use action: list to inspect available personas.";
				return { content: [{ type: "text" as const, text }], details: { errorMessage: text }, isError: true };
			}

			const selectedName = params.agent?.trim() || "worker";
			const persona = discovery.agents.find((agent) => agent.name === selectedName);
			if (!persona) {
				const text = `Unknown persona '${selectedName}'.\n\n${listText(discovery)}`;
				return { content: [{ type: "text" as const, text }], details: { errorMessage: text, availableAgents: discovery.agents.map((agent) => agent.name) }, isError: true };
			}

			const explicitModel = params.model?.trim();
			const selectedModel = explicitModel || persona.model || modelId(ctx);
			const inheritThinking = !explicitModel && !persona.model ? ctx.thinkingLevel : undefined;
			const addDisplayDetails = (partial: TinySubagentResult) => ({
				...partial,
				agent: persona.name,
				description: persona.description,
				systemPrompt: persona.systemPrompt,
				prompt: params.prompt as string,
				personaPath: persona.filePath,
			});
			const result = await runTinySubagent(params.prompt, {
				...(selectedModel ? { model: selectedModel } : {}),
				...(inheritThinking ? { thinking: inheritThinking } : {}),
				...(persona.tools ? { tools: persona.tools } : {}),
				systemPrompt: persona.systemPrompt,
				cwd: ctx.cwd,
				signal,
				onUpdate: (partial) => {
					onUpdate?.({
						content: [{ type: "text" as const, text: partial.output || "(running...)" }],
						details: addDisplayDetails(partial),
					});
				},
			});
			return {
				content: [{ type: "text" as const, text: renderSummary(result) }],
				details: addDisplayDetails(result),
				...(result.ok ? {} : { isError: true }),
			};
		},

		renderCall(args, theme) {
			if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("tiny_subagents list")), 0, 0);
			const agent = args.agent || "worker";
			const model = args.model ? ` ${theme.fg("accent", String(args.model))}` : "";
			const prompt = args.prompt ? String(args.prompt).replace(/\s+/g, " ") : "...";
			const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
			return new Text(`${theme.fg("toolTitle", theme.bold("tiny_subagents"))} ${theme.fg("accent", agent)}${model}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as TinySubagentDetails | undefined;
			if (!details?.agent || !details.messages) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const model = details.model ?? "parent session model";
			const status = isPartial ? "running" : details.ok ? "completed" : "failed";
			const statusColor = isPartial ? "warning" : details.ok ? "success" : "error";
			const statusText = theme.fg(statusColor, status);
			const fullOutputPath = details.artifacts?.finalOutput;
			let finalOutput = details.output || "(no output)";
			if (expanded && fullOutputPath && existsSync(fullOutputPath)) finalOutput = readFileSync(fullOutputPath, "utf8");

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(details.agent))} ${statusText}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", `Model: ${model}`), 0, 0));
				container.addChild(new Text(theme.fg("muted", `Description: ${details.description}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "--- Prompt ---"), 0, 0));
				container.addChild(new Text(details.prompt, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "--- Agent identity ---"), 0, 0));
				container.addChild(new Markdown(details.systemPrompt || "(empty)", 0, 0, getMarkdownTheme()));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "--- Child transcript ---"), 0, 0));
				const transcript = details.messages.flatMap(messageLines);
				if (transcript.length === 0) container.addChild(new Text(theme.fg("dim", "waiting for child events..."), 0, 0));
				else for (const line of transcript) container.addChild(new Text(line, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "--- Final output ---"), 0, 0));
				container.addChild(new Markdown(finalOutput, 0, 0, getMarkdownTheme()));
				if (details.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
				return container;
			}

			const preview = latestActivity(details.messages).replace(/\s+/g, " ");
			const compactPreview = preview.length > 100 ? `${preview.slice(0, 100)}...` : preview;
			return new Text(`${theme.fg("toolTitle", theme.bold(details.agent))} ${statusText} ${theme.fg("dim", `(${model})`)}\n  ${theme.fg("dim", compactPreview)}\n  ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`, 0, 0);
		},
	});
}
