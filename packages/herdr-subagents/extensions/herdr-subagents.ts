import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Text } from "@earendil-works/pi-tui";
import { loadSubagentConfiguration } from "../src/config.ts";
import { CliHerdrAutomation, type HerdrAutomation } from "../src/herdr.ts";
import { activeRunText } from "../src/monitor.ts";
import { historyText, listSubagentHistory } from "../src/history.ts";
import { cancelActiveSubagentRuns } from "../src/reconcile.ts";
import { executeHerdrSubagents, executeHerdrSubagentsControl, type HerdrSubagentsBatchDetails, type HerdrSubagentsControlToolParams, type HerdrSubagentsRunParams } from "../src/tool.ts";
import { HerdrSubagentsControlParams, HerdrSubagentsParams } from "../src/parameters.ts";
import { HERDR_ACTIONS } from "../src/validation.ts";
import { FleetController, type FleetWidgetRuntime } from "../src/fleet-controller.ts";

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

function statusVisual(status: string): { color: "success" | "warning" | "error" | "accent"; glyph: string } {
	if (status === "completed") return { color: "success", glyph: "✓" };
	if (status === "blocked") return { color: "warning", glyph: "?" };
	if (status === "cancelled" || status === "partial") return { color: "warning", glyph: "−" };
	if (status === "starting" || status === "queued" || status === "running") return { color: "accent", glyph: "·" };
	return { color: "error", glyph: "✗" };
}

function renderToolCall(args: HerdrSubagentsRunParams, theme: Theme): Text {
	return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents"))} ${theme.fg("accent", `${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}`)}${theme.fg("muted", ` · concurrency ${args.concurrency ?? "default"}`)}`, 0, 0);
}

function renderControlToolCall(args: HerdrSubagentsControlToolParams, theme: Theme): Text {
	const action = HERDR_ACTIONS[args.action];
	const runId = action.includeRunId ? ` ${theme.fg("muted", String(args.runId ?? ""))}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(`herdr_subagents_control ${args.action}`))}${runId}`, 0, 0);
}

export function normalizeHerdrSubagentsArguments(args: unknown): HerdrSubagentsRunParams {
	if (!args || typeof args !== "object") return args as HerdrSubagentsRunParams;
	const legacy = args as Record<string, unknown>;
	if (Array.isArray(legacy.tasks) || typeof legacy.prompt !== "string" || legacy.action !== undefined) return args as HerdrSubagentsRunParams;
	if (Object.keys(legacy).some((key) => !["prompt", "agent", "label", "model"].includes(key))) return args as HerdrSubagentsRunParams;
	const label = typeof legacy.label === "string" ? legacy.label : undefined;
	return {
		tasks: [{
			name: label || "task",
			prompt: legacy.prompt,
			...(typeof legacy.agent === "string" ? { agent: legacy.agent } : {}),
			...(typeof legacy.model === "string" ? { model: legacy.model } : {}),
		}],
		...(label ? { label } : {}),
	};
}

function renderToolResult(result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme): Container | Text {
	const batch = result.details as HerdrSubagentsBatchDetails | undefined;
	if (batch?.tasks && "effectiveConcurrency" in batch) {
		const container = new Container();
		const visual = statusVisual(batch.status);
		container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(batch.label))} ${theme.fg(visual.color, batch.status)} · ${batch.tasks.length} settled · concurrency ${batch.effectiveConcurrency}`, 0, 0));
		for (const task of batch.tasks) container.addChild(new Text(`${statusVisual(task.status).glyph} ${task.name}: ${task.summary}`, 0, 0));
		return container;
	}
	const content = result.content[0];
	return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
}

async function handleHerdrCommand(args: string, ctx: ExtensionCommandContext, fleet: FleetController): Promise<void> {
	const section = args.trim() || "active";
	if (section === "active") {
		ctx.ui.notify(fleet.active ? activeRunText(fleet.active) : "No active Subagent run.", "info");
		return;
	}
	if (section === "history") {
		ctx.ui.notify(historyText(await listSubagentHistory(ctx.cwd)), "info");
		return;
	}
	if (section.startsWith("focus ")) {
		if (!await fleet.focus(Number(section.slice(6).trim()))) ctx.ui.notify("That task is not active in a Herdr pane.", "warning");
		return;
	}
	if (section === "models") {
		await ctx.modelRegistry.refresh();
		const lines = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`).sort();
		ctx.ui.notify(lines.length ? `Available Pi models:\n${lines.join("\n")}` : "No authenticated Pi models are available.", "info");
		return;
	}
	const configuration = loadSubagentConfiguration(ctx.cwd, packageAgentsDir, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (section === "agents") {
		ctx.ui.notify(configuration.personas.map((persona) => `${persona.name}: ${persona.source}, ${persona.access}, model=${persona.model ?? "unresolved"} (${persona.modelSource}), thinking=${persona.thinking ?? "default"}, tools=${persona.tools?.join(",") ?? "default"}, skills=${persona.skills.join(",") || "none"}, extensions=${persona.extensions.join(",") || "none"} (${persona.extensionsSource})`).join("\n"), "info");
		return;
	}
	if (section === "settings") {
		const settings = configuration.settings;
		const values: Record<string, string | number | undefined> = { defaultConcurrency: settings.defaultConcurrency, maxConcurrency: settings.maxConcurrency, stalledWarningSeconds: settings.stalledWarningSeconds, defaultModel: settings.defaultModel, defaultThinking: settings.defaultThinking };
		const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "unset")} (${configuration.settingSources[key] ?? "built-in"})`);
		if (configuration.diagnostics.length) lines.push("Diagnostics:", ...configuration.diagnostics);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	ctx.ui.notify("Usage: /herdr-subagents active|history|focus <task-number>|agents|models|settings", "warning");
}

export interface HerdrSubagentsExtensionDependencies {
	herdr?: HerdrAutomation;
	execute?: typeof executeHerdrSubagents;
	executeControl?: typeof executeHerdrSubagentsControl;
	isEditor?: (value: unknown) => boolean;
	createFleetWidget?: (lines: string[]) => Container;
	fleetWidgetRuntime?: FleetWidgetRuntime;
}

async function shutdownParentSession(options: { cwd: string; herdr: HerdrAutomation; owner: { sessionId?: string; processId: number }; fleet: FleetController; sessionController: AbortController; runControllers: Map<string, AbortController>; inFlight: Set<Promise<unknown>>; notify: (message: string) => void }): Promise<void> {
	options.sessionController.abort(new Error("Parent Pi session closed."));
	for (const controller of options.runControllers.values()) controller.abort(new Error("Parent Pi session closed."));
	options.fleet.shutdown();
	await Promise.allSettled([...options.inFlight]);
	const cancellation = await cancelActiveSubagentRuns(options.cwd, options.herdr, { reason: "Parent Pi session closed.", owner: options.owner });
	for (const message of cancellation.cleanupErrors) options.notify(message);
}

export function registerHerdrSubagents(pi: ExtensionAPI, dependencies: HerdrSubagentsExtensionDependencies = {}) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1" || process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) return;
	const herdr = dependencies.herdr ?? new CliHerdrAutomation();
	const execute = dependencies.execute ?? executeHerdrSubagents;
	const executeControl = dependencies.executeControl ?? executeHerdrSubagentsControl;
	const isEditorComponent = dependencies.isEditor ?? ((value: unknown) => value instanceof Editor);
	const fleet = new FleetController(herdr, isEditorComponent, dependencies.createFleetWidget, dependencies.fleetWidgetRuntime);
	const runControllers = new Map<string, AbortController>();
	const runPromises = new Map<string, Promise<unknown>>();
	const inFlight = new Set<Promise<unknown>>();
	let sessionController = new AbortController();
	let ownerSessionId: string | undefined;

	pi.on("session_shutdown", async (_event, ctx) => {
		await shutdownParentSession({ cwd: ctx.cwd, herdr, owner: { sessionId: ownerSessionId, processId: process.pid }, fleet, sessionController, runControllers, inFlight, notify: (message) => ctx.ui.notify(message, "error") });
	});
	pi.on("session_start", (_event, ctx) => {
		sessionController.abort(new Error("Parent Pi session changed."));
		sessionController = new AbortController();
		ownerSessionId = `${ctx.sessionManager.getSessionId()}:${randomUUID()}`;
		fleet.bind(ctx.ui, ctx.mode === "tui");
	});

	pi.registerTool({
		name: "herdr_subagents",
		label: "Herdr Subagents",
		description: "Run one or more ordered tasks in visible, focusable Herdr Pi panes. concurrency 1 is strict serial execution; higher values form a bounded pool for read-only tasks. Write-capable tasks require concurrency 1. The call returns only after every task has one terminal completed, failed, or cancelled result. Complete results and Pi sessions stay in project-local records.",
		promptSnippet: "Run focused work in visible Herdr subagents",
		parameters: HerdrSubagentsParams,
		prepareArguments: normalizeHerdrSubagentsArguments,

		async execute(_toolCallId, params: HerdrSubagentsRunParams, signal, onUpdate, ctx) {
			const runId = randomUUID();
			const controller = new AbortController();
			const runSignal = AbortSignal.any([controller.signal, sessionController.signal, ...(signal ? [signal] : [])]);
			runControllers.set(runId, controller);
			const promise = execute(params, runSignal, (update) => {
				const details = update.details as HerdrSubagentsBatchDetails | undefined;
				if (details?.activity) fleet.sync(details);
				onUpdate?.(update);
			}, ctx, {
				agentsDirectory: packageAgentsDir,
				herdr,
				owner: { sessionId: ownerSessionId, processId: process.pid },
				runId,
			});
			runPromises.set(runId, promise);
			inFlight.add(promise);
			try {
				const result = await promise;
				fleet.sync(result.details);
				return result;
			} finally {
				inFlight.delete(promise);
				runPromises.delete(runId);
				runControllers.delete(runId);
			}
		},

		renderCall: renderToolCall,
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "herdr_subagents_control",
		label: "Herdr Subagents Control",
		description: "Inspect Herdr personas, query one run by ID, list run history, cancel active work, or remove an archived run. Use herdr_subagents to start new work.",
		parameters: HerdrSubagentsControlParams,

		async execute(_toolCallId, params: HerdrSubagentsControlToolParams, signal, onUpdate, ctx) {
			const executionId = randomUUID();
			const controller = new AbortController();
			runControllers.set(executionId, controller);
			const runSignal = AbortSignal.any([controller.signal, sessionController.signal, ...(signal ? [signal] : [])]);
			const promise = executeControl(params, runSignal, (update) => {
				const details = update.details as HerdrSubagentsBatchDetails | undefined;
				if (details?.activity) fleet.sync(details);
				const updateText = update.content.find((item) => item.type === "text")?.text;
				const updateDetails = update.details as { warning?: string };
				if (updateDetails.warning || updateText?.includes("cleanup failed")) ctx.ui.notify(updateDetails.warning ?? updateText ?? "Subagent warning", "warning");
				onUpdate?.(update);
			}, ctx, {
				agentsDirectory: packageAgentsDir,
				herdr,
				owner: { sessionId: ownerSessionId, processId: process.pid },
				cancelRun: async (runId) => {
					const reason = new Error("Subagent run cancelled by user.");
					const targetController = runControllers.get(runId);
					targetController?.abort(reason);
					const activePromise = runPromises.get(runId);
					if (activePromise) {
						await activePromise.catch(() => undefined);
						fleet.clearRun(runId);
						return { cancelled: true };
					}
					const cancellation = await cancelActiveSubagentRuns(ctx.cwd, herdr, { reason: reason.message, owner: { sessionId: ownerSessionId, processId: process.pid }, runId });
					if (cancellation.cancelledRuns) {
						fleet.clearRun(runId);
					}
					return { cancelled: cancellation.cancelledRuns > 0, cleanupErrors: cancellation.cleanupErrors };
				},
			});
			inFlight.add(promise);
			const result = await promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); });
			fleet.sync(result.details);
			return result;
		},

		renderCall: renderControlToolCall,
		renderResult: renderToolResult,
	});

	pi.registerCommand("herdr-subagents", {
		description: "Inspect effective subagent agents, models, and settings",
		getArgumentCompletions: (prefix) => ["active", "history", "agents", "models", "settings", "focus "].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: (args, ctx) => handleHerdrCommand(args, ctx, fleet),
	});
}

export default registerHerdrSubagents;
