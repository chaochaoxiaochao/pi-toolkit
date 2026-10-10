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
import { executeHerdrSubagents, executeHerdrSubagentsControl, type HerdrSubagentsBatchDetails, type HerdrSubagentsControlToolParams, type HerdrSubagentsDetails, type HerdrSubagentsRunParams } from "../src/tool.ts";
import { HerdrSubagentsControlParams, HerdrSubagentsParams } from "../src/parameters.ts";
import { HERDR_ACTIONS } from "../src/validation.ts";
import { FleetController, type FleetWidgetRuntime } from "../src/fleet-controller.ts";
import { isSettledRunStatus } from "../src/records.ts";

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
	if (Object.keys(legacy).some((key) => !["prompt", "agent", "label", "model", "background"].includes(key))) return args as HerdrSubagentsRunParams;
	const label = typeof legacy.label === "string" ? legacy.label : undefined;
	return {
		tasks: [{
			name: label || "task",
			prompt: legacy.prompt,
			...(typeof legacy.agent === "string" ? { agent: legacy.agent } : {}),
			...(typeof legacy.model === "string" ? { model: legacy.model } : {}),
		}],
		...(label ? { label } : {}),
		...(typeof legacy.background === "boolean" ? { background: legacy.background } : {}),
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
	const details = result.details as HerdrSubagentsDetails | undefined;
	if (details?.agent) {
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
		ctx.ui.notify(configuration.personas.map((persona) => `${persona.name}: ${persona.source}, ${persona.access}, model=${persona.model ?? "unresolved"} (${persona.modelSource}), thinking=${persona.thinking ?? "default"}, tools=${persona.tools?.join(",") ?? "default"}, skills=${persona.skills.join(",") || "none"}`).join("\n"), "info");
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
	const executeControl = dependencies.executeControl ?? executeHerdrSubagentsControl;
	const isEditorComponent = dependencies.isEditor ?? ((value: unknown) => value instanceof Editor);
	const dispatcher = new RunDispatcher();
	const fleet = new FleetController(herdr, isEditorComponent, dependencies.createFleetWidget, dependencies.fleetWidgetRuntime);
	const runControllers = new Map<string, AbortController>();
	const runPromises = new Map<string, Promise<unknown>>();
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
		description: "Run one or more ordered tasks in visible interactive Herdr Pi Agents. Use one tasks item for a single task. Independent read-only tasks may run concurrently; write-capable runs are serialized. Only effectively serial runs can pause for input; concurrent input requests become missing_input failures while independent siblings continue. Foreground calls wait for the batch unless a task fails, when the run continues in the background and returns its run ID immediately. Explicit background calls always return a run ID immediately. Complete results and Pi sessions stay in project-local records.",
		promptSnippet: "Run focused work in visible Herdr subagents",
		parameters: HerdrSubagentsParams,
		prepareArguments: normalizeHerdrSubagentsArguments,

		async execute(_toolCallId, params: HerdrSubagentsRunParams, signal, onUpdate, ctx) {
			const blockedForegroundResponse = (blockingRunId: string) => {
				const text = `Cannot start a foreground Subagent run while blocked run ${blockingRunId} is waiting for input. Respond to or cancel that run first, or submit this run with background: true.`;
				return { content: [{ type: "text" as const, text }], details: { errorMessage: text, blockingRunId }, isError: true };
			};
			const blockingRunId = dispatcher.snapshot().retainedRunId;
			if (!params.background && blockingRunId) return blockedForegroundResponse(blockingRunId);
			const generation = sessionGeneration;
			const runId = randomUUID();
			const controller = new AbortController();
			const foregroundController = new AbortController();
			let foregroundAttached = !params.background;
			const abortForeground = () => {
				if (foregroundAttached && signal?.aborted) foregroundController.abort(signal.reason);
			};
			if (foregroundAttached) {
				if (signal?.aborted) abortForeground();
				else signal?.addEventListener("abort", abortForeground, { once: true });
			}
			runControllers.set(runId, controller);
			const runSignal = AbortSignal.any([controller.signal, sessionController.signal, ...(!params.background ? [foregroundController.signal] : [])]);
			let resolveEarlyFailure: ((details: HerdrSubagentsBatchDetails) => void) | undefined;
			const earlyFailure = new Promise<HerdrSubagentsBatchDetails>((resolve) => { resolveEarlyFailure = resolve; });
			let failureObserved = false;
			let runSettled = false;
			const executeRun = async () => {
				const result = await execute(params, runSignal, (update) => {
					const details = update.details as HerdrSubagentsBatchDetails | undefined;
					if (details?.activity) fleet.sync(details);
					const hasUnfinishedSibling = details?.activity?.some((task) => task.status === "queued" || task.status === "running");
					if (!params.background && !failureObserved && details?.effectiveConcurrency > 1 && hasUnfinishedSibling && details.tasks?.some((task) => task.status === "failed")) {
						failureObserved = true;
						foregroundAttached = false;
						signal?.removeEventListener("abort", abortForeground);
						resolveEarlyFailure?.(details);
					}
					const updateText = update.content.find((item) => item.type === "text")?.text;
					const updateDetails = update.details as { warning?: string };
					if (updateDetails.warning || updateText?.includes("cleanup failed") || (!foregroundAttached && updateText?.includes("appears stalled"))) ctx.ui.notify(updateDetails.warning ?? updateText ?? "Subagent warning", "warning");
					if (foregroundAttached) onUpdate?.(update);
				}, ctx, { agentsDirectory: packageAgentsDir, owner: { sessionId: ownerSessionId, processId: process.pid }, runId });
				fleet.sync(result.details);
				return result;
			};
			if (params.background) await persistQueuedRun(ctx.cwd, runId, params, { sessionId: ownerSessionId, processId: process.pid });
			const promise = dispatcher.submit(runId, async () => {
				const result = await executeRun();
				const details = result.details as HerdrSubagentsBatchDetails;
				const ownsDispatcher = dispatcher.snapshot().activeRunId === runId;
				if (ownsDispatcher) fleet.setActive(details.status === "blocked" ? details : undefined);
				else if (details.status === "blocked") fleet.clearRun(runId);
				if (ownsDispatcher && fleet.active) {
					dispatcher.retain(runId);
				}
				return result;
			}, params.background ? undefined : { ...(signal ? { signal } : {}), onRetained: blockedForegroundResponse });
			runPromises.set(runId, promise);
			inFlight.add(promise);
			void promise.finally(() => {
				runSettled = true;
				foregroundAttached = false;
				signal?.removeEventListener("abort", abortForeground);
				inFlight.delete(promise);
				runControllers.delete(runId);
				runPromises.delete(runId);
			}).catch(() => undefined);
			let backgroundLifecycleStarted = false;
			const startBackgroundLifecycle = () => {
				if (backgroundLifecycleStarted) return;
				backgroundLifecycleStarted = true;
				const lifecycle = promise.then((result) => {
					if (generation !== sessionGeneration) return;
					notifyRun(runId, result);
					if (!fleet.active && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) fleet.render();
				}).catch((error) => {
					if (generation !== sessionGeneration) return;
					if (controller.signal.aborted) {
						pi.sendMessage({ customType: "herdr-subagents-run", content: `Subagent run ${runId} cancelled.`, display: true, details: { runId, status: "cancelled" } }, { triggerTurn: true, deliverAs: "followUp" });
						return;
					}
					pi.sendMessage({ customType: "herdr-subagents-run", content: `Subagent run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
				}).finally(() => removeQueuedRun(ctx.cwd, runId));
				inFlight.add(lifecycle);
				void lifecycle.finally(() => inFlight.delete(lifecycle)).catch(() => undefined);
			};
			if (params.background) {
				startBackgroundLifecycle();
				return { content: [{ type: "text" as const, text: `Subagent run queued: ${runId}` }], details: { runId, status: "queued", background: true } };
			}
			const foregroundOutcome = await Promise.race([
				promise.then((result) => ({ kind: "settled" as const, result })),
				earlyFailure.then((details) => ({ kind: "failed" as const, details })),
			]);
			if (foregroundOutcome.kind === "failed") {
				try {
					await persistQueuedRun(ctx.cwd, runId, params, { sessionId: ownerSessionId, processId: process.pid });
				} catch (error) {
					controller.abort(new Error("Could not persist failed foreground run for background continuation."));
					await promise.catch(() => undefined);
					await removeQueuedRun(ctx.cwd, runId).catch(() => undefined);
					throw error;
				}
				if (runSettled) {
					await removeQueuedRun(ctx.cwd, runId);
					return promise;
				}
				dispatcher.detach(runId);
				startBackgroundLifecycle();
				const failedTask = foregroundOutcome.details.tasks.find((task) => task.status === "failed");
				const failure = failedTask?.error ?? failedTask?.summary ?? "Unknown task failure.";
				return {
					content: [{ type: "text" as const, text: `Subagent run ${runId} continues in the background after ${failedTask?.name ?? "a task"} failed: ${failure}` }],
					details: { ...foregroundOutcome.details, runId, background: true, earlyReturn: true, failedTask: failedTask ? { index: failedTask.index, name: failedTask.name, summary: failedTask.summary, ...(failedTask.error ? { error: failedTask.error } : {}) } : undefined },
					isError: true,
				};
			}
			const result = foregroundOutcome.result;
			if (!fleet.active && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) fleet.resetSelection();
			return result;
		},

		renderCall: renderToolCall,
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "herdr_subagents_control",
		label: "Herdr Subagents Control",
		description: "Inspect Herdr personas, query one run by ID, list run history, cancel active or queued work, answer a blocked task, resume a saved task, or remove a selected archived run. Use status for one run and history only for the full archive. Use herdr_subagents to start new work.",
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
					if (dispatcher.cancelQueuedRun(runId, reason)) {
						await cancelQueuedRuns(ctx.cwd, [runId], { reason: reason.message, owner: { sessionId: ownerSessionId, processId: process.pid } });
						fleet.clearRun(runId);
						return { cancelled: true, queued: true };
					}
					const activePromise = runPromises.get(runId);
					if (activePromise) {
						await activePromise.catch(() => undefined);
						fleet.clearRun(runId);
						dispatcher.release(runId);
						return { cancelled: true };
					}
					const cancellation = await cancelActiveSubagentRuns(ctx.cwd, herdr, { reason: reason.message, owner: { sessionId: ownerSessionId, processId: process.pid }, runId });
					if (cancellation.cancelledRuns) {
						fleet.clearRun(runId);
						dispatcher.release(runId);
					}
					return { cancelled: cancellation.cancelledRuns > 0, cleanupErrors: cancellation.cleanupErrors };
				},
			});
			inFlight.add(promise);
			const result = await promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); });
			fleet.sync(result.details);
			if (params.action === "respond") {
				const details = result.details as { runId?: string; status?: string };
				if (details.status === "blocked") fleet.sync(result.details);
				else if (isSettledRunStatus(details.status)) {
					const canonicalRunId = details.runId ?? params.runId;
					fleet.clearRun(canonicalRunId);
					if (canonicalRunId) dispatcher.release(canonicalRunId);
				}
			}
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
