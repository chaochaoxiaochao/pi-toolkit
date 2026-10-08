import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Spacer, Text } from "@earendil-works/pi-tui";
import { loadSubagentConfiguration } from "../src/config.ts";
import { CliHerdrAutomation, type HerdrAutomation } from "../src/herdr.ts";
import { activeRunText } from "../src/monitor.ts";
import { RunDispatcher } from "../src/dispatcher.ts";
import { historyText, listSubagentHistory } from "../src/history.ts";
import { cancelQueuedRuns, loadQueuedRuns, persistQueuedRun, removeQueuedRun } from "../src/queued-runs.ts";
import { cancelActiveSubagentRuns, reconcileSubagentRuns } from "../src/reconcile.ts";
import { executeHerdrSubagents, type HerdrSubagentsBatchDetails, type HerdrSubagentsDetails, type HerdrSubagentsToolParams } from "../src/tool.ts";
import { HerdrSubagentsParams } from "../src/parameters.ts";
import { HERDR_ACTIONS } from "../src/validation.ts";
import { FleetController } from "../src/fleet-controller.ts";
import { isSettledRunStatus } from "../src/records.ts";

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

function statusVisual(status: string): { color: "success" | "warning" | "error" | "accent"; glyph: string } {
	if (status === "completed") return { color: "success", glyph: "✓" };
	if (status === "blocked") return { color: "warning", glyph: "?" };
	if (status === "cancelled" || status === "partial") return { color: "warning", glyph: "−" };
	if (status === "starting" || status === "queued" || status === "running") return { color: "accent", glyph: "·" };
	return { color: "error", glyph: "✗" };
}

function renderToolCall(args: HerdrSubagentsToolParams, theme: Theme): Text {
	if (args.action) {
		const action = HERDR_ACTIONS[args.action];
		const runId = action.includeRunId ? ` ${theme.fg("muted", String(args.runId ?? ""))}` : "";
		return new Text(`${theme.fg("toolTitle", theme.bold(`herdr_subagents ${args.action}`))}${runId}`, 0, 0);
	}
	if (args.tasks) return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents"))} ${theme.fg("accent", `${args.tasks.length} tasks`)}${theme.fg("muted", ` · concurrency ${args.concurrency ?? "default"}`)}`, 0, 0);
	const agent = args.agent || "worker";
	const label = args.label ? ` · ${String(args.label)}` : "";
	const prompt = args.prompt ? String(args.prompt).replace(/\s+/g, " ") : "...";
	const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
	return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents"))} ${theme.fg("accent", agent)}${theme.fg("muted", label)}\n  ${theme.fg("dim", preview)}`, 0, 0);
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
	const details = result.details as HerdrSubagentsDetails | undefined;
	if (!details?.agent) {
		const content = result.content[0];
		return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(details.agent))} ${theme.fg(statusVisual(details.status).color, details.status)}`, 0, 0));
	container.addChild(new Text(details.summary, 0, 0));
	if (details.documents.length > 0) {
		container.addChild(new Spacer(1));
		for (const document of details.documents) container.addChild(new Text(theme.fg("muted", `${document.description}: ${document.path}`), 0, 0));
	}
	if (details.recordDirectory) container.addChild(new Text(theme.fg("dim", `Record: ${details.recordDirectory}`), 0, 0));
	if (details.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
	return container;
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
		ctx.ui.notify(configuration.personas.map((persona) => `${persona.name}: ${persona.source}, ${persona.access}, model=${persona.model ?? "unresolved"} (${persona.modelSource}), thinking=${persona.thinking ?? "default"}, tools=${persona.tools?.join(",") ?? "default"}, skills=${persona.skills.join(",") || "none"}`).join("\n"), "info");
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
	ctx.ui.notify("Usage: /herdr-subagents active|history|focus <task-number>|agents|models|settings", "warning");
}

export interface HerdrSubagentsExtensionDependencies {
	herdr?: HerdrAutomation;
	execute?: typeof executeHerdrSubagents;
	isEditor?: (value: unknown) => boolean;
	createFleetWidget?: (lines: string[]) => Container;
}

async function recoverParentSession(cwd: string, herdr: HerdrAutomation, owner: { sessionId?: string; processId: number }, notify: (message: string) => void): Promise<void> {
	try {
		const queued = await loadQueuedRuns(cwd, notify);
		await cancelQueuedRuns(cwd, queued.map((run) => run.runId), { reason: "Owning parent Pi session is no longer active.", owner, onlyOrphaned: true, onError: notify });
	}
	catch (error) { notify(`Subagent queue recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
	try {
		const reconciliation = await reconcileSubagentRuns(cwd, herdr, owner);
		for (const message of reconciliation.cleanupErrors) notify(message);
	}
	catch (error) { notify(`Subagent recovery could not inspect active runs: ${error instanceof Error ? error.message : String(error)}`); }
}

async function shutdownParentSession(options: { cwd: string; herdr: HerdrAutomation; owner: { sessionId?: string; processId: number }; dispatcher: RunDispatcher; fleet: FleetController; sessionController: AbortController; runControllers: Map<string, AbortController>; inFlight: Set<Promise<unknown>>; notify: (message: string) => void }): Promise<void> {
	options.dispatcher.pause();
	options.sessionController.abort(new Error("Parent Pi session closed."));
	const queuedRunIds = options.dispatcher.cancelQueued(new Error("Parent Pi session closed."));
	await cancelQueuedRuns(options.cwd, queuedRunIds, { reason: "Parent Pi session closed.", owner: options.owner });
	for (const controller of options.runControllers.values()) controller.abort(new Error("Parent Pi session closed."));
	options.fleet.shutdown();
	await Promise.allSettled([...options.inFlight]);
	const cancellation = await cancelActiveSubagentRuns(options.cwd, options.herdr, { reason: "Parent Pi session closed.", owner: options.owner });
	const retainedRunId = options.dispatcher.snapshot().activeRunId;
	if (retainedRunId) options.dispatcher.release(retainedRunId);
	for (const message of cancellation.cleanupErrors) options.notify(message);
}

export function registerHerdrSubagents(pi: ExtensionAPI, dependencies: HerdrSubagentsExtensionDependencies = {}) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1" || process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) return;
	const herdr = dependencies.herdr ?? new CliHerdrAutomation();
	const execute = dependencies.execute ?? executeHerdrSubagents;
	const isEditorComponent = dependencies.isEditor ?? ((value: unknown) => value instanceof Editor);
	const dispatcher = new RunDispatcher();
	const fleet = new FleetController(herdr, isEditorComponent, dependencies.createFleetWidget);
	const runControllers = new Map<string, AbortController>();
	const inFlight = new Set<Promise<unknown>>();
	let sessionController = new AbortController();
	let ownerSessionId: string | undefined;
	let sessionGeneration = 0;
	const notifyRun = (runId: string, result: { details: unknown; content?: Array<{ type: string; text?: string }> }) => {
		const details = result.details as Partial<HerdrSubagentsBatchDetails> & { errorMessage?: string };
		if (!details.tasks || !details.documents || !details.status) {
			const error = details.errorMessage ?? result.content?.find((item) => item.type === "text")?.text ?? "Unknown Subagent failure.";
			pi.sendMessage({ customType: "herdr-subagents-run", content: `Subagent run ${runId} failed: ${error}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		const lines = [`Subagent run ${runId} ${details.status}: ${details.summary}`, ...details.tasks.map((task) => `- ${task.name}: ${task.summary}`)];
		if (details.documents.length) lines.push("Documents:", ...details.documents.map((document) => `- ${document.description}: ${document.path}`));
		pi.sendMessage({ customType: "herdr-subagents-run", content: lines.join("\n"), display: true, details: { runId, status: details.status } }, { triggerTurn: true, deliverAs: "followUp" });
	};

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionGeneration += 1;
		await shutdownParentSession({ cwd: ctx.cwd, herdr, owner: { sessionId: ownerSessionId, processId: process.pid }, dispatcher, fleet, sessionController, runControllers, inFlight, notify: (message) => ctx.ui.notify(message, "error") });
	});
	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		sessionController.abort(new Error("Parent Pi session changed."));
		sessionController = new AbortController();
		ownerSessionId = `${ctx.sessionManager.getSessionId()}:${randomUUID()}`;
		fleet.bind(ctx.ui, ctx.mode === "tui");
		dispatcher.pause();
		try { await recoverParentSession(ctx.cwd, herdr, { sessionId: ownerSessionId, processId: process.pid }, (message) => ctx.ui.notify(message, "error")); }
		finally { dispatcher.resume(); }
	});

	pi.registerTool({
		name: "herdr_subagents",
		label: "Herdr Subagents",
		description: "Run one focused task or an ordered bounded-concurrency batch in visible interactive Herdr Pi Agents. Foreground calls block while workers run concurrently; background batches return a run ID immediately and publish completion later. Complete results and Pi sessions stay in project-local records.",
		promptSnippet: "Run focused work in visible Herdr subagents",
		promptGuidelines: ["Call action=list once before the first execution. Submit one prompt or an ordered tasks list; use concurrency only for independent read-only tasks. Foreground calls block until the run settles; background calls return a run ID immediately."],
		parameters: HerdrSubagentsParams,

		async execute(_toolCallId, params: HerdrSubagentsToolParams, signal, onUpdate, ctx) {
			const generation = sessionGeneration;
			const runId = params.tasks ? randomUUID() : undefined;
			const executionId = runId ?? params.runId ?? randomUUID();
			const controller = new AbortController();
			runControllers.set(executionId, controller);
			const runSignal = AbortSignal.any([controller.signal, sessionController.signal, ...(!params.background && signal ? [signal] : [])]);
			const executeRun = async () => {
				const result = await execute(params, runSignal, (update) => {
				const details = update.details as HerdrSubagentsBatchDetails | undefined;
				if (details?.activity) fleet.sync(details);
				const updateText = update.content.find((item) => item.type === "text")?.text;
				const updateDetails = update.details as { warning?: string };
				if (updateDetails.warning || updateText?.includes("cleanup failed") || (params.background && updateText?.includes("appears stalled"))) ctx.ui.notify(updateDetails.warning ?? updateText ?? "Subagent warning", "warning");
				if (!params.background) onUpdate?.(update);
				}, ctx, { agentsDirectory: packageAgentsDir, owner: { sessionId: ownerSessionId, processId: process.pid }, runId });
				fleet.sync(result.details);
				return result;
			};
			if (!params.tasks) {
				const promise = executeRun();
				inFlight.add(promise);
				const result = await promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); });
				if (params.action === "respond") {
					const details = result.details as { runId?: string; status?: string };
					if (details.status === "blocked") fleet.sync(result.details);
					else if (isSettledRunStatus(details.status)) {
						fleet.clearRun(params.runId);
						if (params.runId) dispatcher.release(params.runId);
					}
				}
				return result;
			}
			if (!runId) throw new Error("Batch run ID was not allocated.");
			if (params.background) await persistQueuedRun(ctx.cwd, runId, params, { sessionId: ownerSessionId, processId: process.pid });
			const promise = dispatcher.submit(runId, async () => {
				const result = await executeRun().finally(async () => { if (params.background) await removeQueuedRun(ctx.cwd, runId); });
					const details = result.details as HerdrSubagentsBatchDetails;
					fleet.setActive(details.status === "blocked" ? details : undefined);
					if (fleet.active) {
						dispatcher.retain(runId);
				}
				return result;
			});
			inFlight.add(promise);
			void promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); }).catch(() => undefined);
			if (params.background) {
				void promise.then((result) => {
					if (generation !== sessionGeneration) return;
					notifyRun(runId, result);
					if (!fleet.active && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) fleet.render();
				}).catch((error) => {
					if (generation !== sessionGeneration) return;
					pi.sendMessage({ customType: "herdr-subagents-run", content: `Subagent run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
				});
				return { content: [{ type: "text" as const, text: `Subagent run queued: ${runId}` }], details: { runId, status: "queued", background: true } };
			}
			const result = await promise;
			if (!fleet.active && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) fleet.resetSelection();
			return result;
		},

		renderCall: renderToolCall,
		renderResult: renderToolResult,
	});

	pi.registerCommand("herdr-subagents", {
		description: "Inspect effective subagent agents, models, and settings",
		getArgumentCompletions: (prefix) => ["active", "history", "agents", "models", "settings", "focus "].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: (args, ctx) => handleHerdrCommand(args, ctx, fleet),
	});
}

export default registerHerdrSubagents;
