import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSubagentConfiguration } from "../src/config.ts";
import { executeTinySubagent, type TinySubagentDetails, type TinySubagentToolParams } from "../src/tool.ts";

const ACTIONS = ["list"] as const;
const TinySubagentParams = Type.Union([
	Type.Object({
		action: StringEnum(ACTIONS, { description: "Discover package-local personas before execution." }),
	}),
	Type.Object({
		prompt: Type.String({ minLength: 1, description: "One self-contained task for the subagent." }),
		agent: Type.Optional(Type.String({ minLength: 1, description: "Persona name selected from action=list. Defaults to worker." })),
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 48, description: "Short label for the Herdr run tab." })),
		model: Type.Optional(Type.String({ minLength: 1, description: "Optional Pi model, for example provider/model:high." })),
	}),
]);

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.registerTool({
		name: "tiny_subagents",
		label: "Tiny Subagent",
		description: "Run one focused task synchronously in a visible Herdr tab using a package-local persona. Returns a compact report while the complete result and Pi session stay in project-local records.",
		promptSnippet: "Run one focused task in a visible Herdr subagent",
		promptGuidelines: ["Call action=list once before the first execution, then select a persona and provide a self-contained task. The call blocks until the child reports completion or failure."],
		parameters: TinySubagentParams,

		async execute(_toolCallId, params: TinySubagentToolParams, signal, onUpdate, ctx) {
			return await executeTinySubagent(params, signal, onUpdate, ctx, { agentsDirectory: packageAgentsDir });
		},

		renderCall(args, theme) {
			if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("tiny_subagents list")), 0, 0);
			const agent = args.agent || "worker";
			const label = args.label ? ` · ${String(args.label)}` : "";
			const prompt = args.prompt ? String(args.prompt).replace(/\s+/g, " ") : "...";
			const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
			return new Text(`${theme.fg("toolTitle", theme.bold("tiny_subagents"))} ${theme.fg("accent", agent)}${theme.fg("muted", label)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const details = result.details as TinySubagentDetails | undefined;
			if (!details?.agent) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const status = isPartial ? details.status : details.ok ? "completed" : "failed";
			const statusColor = isPartial ? "warning" : details.ok ? "success" : "error";
			const container = new Container();
			container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(details.agent))} ${theme.fg(statusColor, status)}`, 0, 0));
			container.addChild(new Text(details.summary, 0, 0));
			if (details.documents.length > 0) {
				container.addChild(new Spacer(1));
				for (const document of details.documents) container.addChild(new Text(theme.fg("muted", `${document.description}: ${document.path}`), 0, 0));
			}
			if (details.recordDirectory) container.addChild(new Text(theme.fg("dim", `Record: ${details.recordDirectory}`), 0, 0));
			if (details.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
			return container;
		},
	});

	pi.registerCommand("subagents", {
		description: "Inspect effective subagent agents, models, and settings",
		getArgumentCompletions: (prefix) => ["agents", "models", "settings"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const section = args.trim() || "agents";
			if (section === "models") {
				await ctx.modelRegistry.refresh();
				const lines = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`).sort();
				ctx.ui.notify(lines.length ? `Available Pi models:\n${lines.join("\n")}` : "No authenticated Pi models are available.", "info");
				return;
			}
			const configuration = loadSubagentConfiguration(ctx.cwd, packageAgentsDir, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (section === "agents") {
				const lines = configuration.personas.map((persona) => `${persona.name}: ${persona.source}, ${persona.access}, model=${persona.model ?? "unresolved"} (${persona.modelSource}), thinking=${persona.thinking ?? "default"}, tools=${persona.tools?.join(",") ?? "default"}, skills=${persona.skills.join(",") || "none"}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (section === "settings") {
				const settings = configuration.settings;
				const values: Record<string, string | number | undefined> = { defaultConcurrency: settings.defaultConcurrency, maxConcurrency: settings.maxConcurrency, stalledWarningSeconds: settings.stalledWarningSeconds, defaultModel: settings.defaultModel };
				const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "unset")} (${configuration.settingSources[key] ?? "built-in"})`);
				if (configuration.diagnostics.length) lines.push("Diagnostics:", ...configuration.diagnostics);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			ctx.ui.notify("Usage: /subagents agents|models|settings", "warning");
		},
	});
}
