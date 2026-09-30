import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, isKeyRelease, Spacer, Text } from "@earendil-works/pi-tui";
import { loadSubagentConfiguration } from "../src/config.ts";
import { CliHerdrAutomation, type HerdrAutomation } from "../src/herdr.ts";
import { activeRunText, focusActiveTask } from "../src/monitor.ts";
import { RunDispatcher } from "../src/dispatcher.ts";
import { historyText, listSubagentHistory } from "../src/history.ts";
import { cancelQueuedRuns, loadQueuedRuns, persistQueuedRun, removeQueuedRun } from "../src/queued-runs.ts";
import { cancelActiveSubagentRuns, reconcileSubagentRuns } from "../src/reconcile.ts";
import { executeHerdrSubagents, type HerdrSubagentsBatchDetails, type HerdrSubagentsDetails, type HerdrSubagentsToolParams } from "../src/tool.ts";
import { HerdrSubagentsParams } from "../src/parameters.ts";
import { fleetEditorHasFocus, FleetSelection, fleetLines } from "../src/fleet.ts";

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

export interface HerdrSubagentsExtensionDependencies {
	herdr?: HerdrAutomation;
	execute?: typeof executeHerdrSubagents;
	isEditor?: (value: unknown) => boolean;
	createFleetWidget?: (lines: string[]) => Container;
}

export function registerHerdrSubagents(pi: ExtensionAPI, dependencies: HerdrSubagentsExtensionDependencies = {}) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1") return;
	let activeBatch: HerdrSubagentsBatchDetails | undefined;
	const herdr = dependencies.herdr ?? new CliHerdrAutomation();
	const execute = dependencies.execute ?? executeHerdrSubagents;
	const isEditorComponent = dependencies.isEditor ?? ((value: unknown) => value instanceof Editor);
	const dispatcher = new RunDispatcher();
	const fleetSelection = new FleetSelection();
	const runControllers = new Map<string, AbortController>();
	const inFlight = new Set<Promise<unknown>>();
	let unsubscribeTerminalInput: (() => void) | undefined;
	let currentUi: ExtensionUIContext | undefined;
	let fleetTui: { focusedComponent?: unknown } | undefined;
	let ownerSessionId: string | undefined;
	let sessionGeneration = 0;
	const renderFleet = () => {
		if (!currentUi) return;
		currentUi.setWidget("herdr-subagents", activeBatch ? ((tui) => {
			fleetTui = tui as { focusedComponent?: unknown };
			const lines = fleetLines(activeBatch as HerdrSubagentsBatchDetails, fleetSelection);
			if (dependencies.createFleetWidget) return dependencies.createFleetWidget(lines);
			const container = new Container();
			for (const line of lines) container.addChild(new Text(line, 1, 0));
			return container;
		}) : undefined, { placement: "belowEditor" });
	};
	const syncActiveBatch = (details: unknown) => {
		const batch = details as Partial<HerdrSubagentsBatchDetails>;
		if (!batch.activity || !batch.label || !batch.status) return;
		activeBatch = ["starting", "running", "blocked", "queued"].includes(batch.status) ? batch as HerdrSubagentsBatchDetails : undefined;
		renderFleet();
	};
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
		dispatcher.pause();
		const queuedRunIds = dispatcher.cancelQueued(new Error("Parent Pi session closed."));
		await cancelQueuedRuns(ctx.cwd, queuedRunIds, { reason: "Parent Pi session closed.", owner: { sessionId: ownerSessionId, processId: process.pid } });
		for (const controller of runControllers.values()) controller.abort(new Error("Parent Pi session closed."));
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		await Promise.allSettled([...inFlight]);
		const cancellation = await cancelActiveSubagentRuns(ctx.cwd, herdr, { reason: "Parent Pi session closed.", owner: { sessionId: ownerSessionId, processId: process.pid } });
		for (const message of cancellation.cleanupErrors) ctx.ui.notify(message, "error");
		activeBatch = undefined;
		fleetSelection.reset();
		renderFleet();
	});
	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		currentUi = ctx.ui;
		ownerSessionId = `${ctx.sessionManager.getSessionId()}:${randomUUID()}`;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.mode === "tui" ? ctx.ui.onTerminalInput((data) => {
			if (!activeBatch) return undefined;
			if (isKeyRelease(data)) return undefined;
			const focused = fleetTui?.focusedComponent;
			if (!fleetEditorHasFocus(focused, isEditorComponent)) {
				fleetSelection.reset();
				renderFleet();
				return undefined;
			}
			const result = fleetSelection.handle(data, ctx.ui.getEditorText(), activeBatch.activity.length);
			if (result.changed) renderFleet();
			if (result.focusTask) void focusActiveTask(activeBatch, result.focusTask, herdr);
			return result.consume ? { consume: true } : undefined;
		}) : undefined;
		dispatcher.pause();
		try {
			const queued = await loadQueuedRuns(ctx.cwd);
			await cancelQueuedRuns(ctx.cwd, queued.map((run) => run.runId), { reason: "Owning parent Pi session is no longer active.", onlyOrphaned: true });
			const reconciliation = await reconcileSubagentRuns(ctx.cwd, herdr, { sessionId: ownerSessionId, processId: process.pid });
			for (const message of reconciliation.cleanupErrors) ctx.ui.notify(message, "error");
		}
		catch (error) { ctx.ui.notify(`Subagent recovery could not inspect Herdr: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
		dispatcher.resume();
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
			const runSignal = !params.background && signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const executeRun = async () => {
				const result = await execute(params, runSignal, (update) => {
				const details = update.details as HerdrSubagentsBatchDetails | undefined;
				if (details?.activity) syncActiveBatch(details);
				const updateText = update.content.find((item) => item.type === "text")?.text;
				if (params.background && updateText && (updateText.includes("appears stalled") || updateText.includes("cleanup failed"))) ctx.ui.notify(updateText, "warning");
				if (!params.background) onUpdate?.(update);
				}, ctx, { agentsDirectory: packageAgentsDir, owner: { sessionId: ownerSessionId, processId: process.pid }, runId });
				syncActiveBatch(result.details);
				return result;
			};
			if (!params.tasks) {
				const promise = executeRun();
				inFlight.add(promise);
				const result = await promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); });
				if (params.action === "respond" && (result.details as { status?: string }).status !== "blocked") { activeBatch = undefined; ctx.ui.setWidget("herdr-subagents", undefined); }
				return result;
			}
			if (!runId) throw new Error("Batch run ID was not allocated.");
			if (params.background) await persistQueuedRun(ctx.cwd, runId, params, { sessionId: ownerSessionId, processId: process.pid });
			const promise = dispatcher.submit(runId, async () => {
				const result = await executeRun();
				if (params.background && (result.details as { runId?: string }).runId === runId) await removeQueuedRun(ctx.cwd, runId);
				const details = result.details as HerdrSubagentsBatchDetails;
				activeBatch = details.status === "blocked" ? details : undefined;
				if (activeBatch) {
					renderFleet();
				}
				return result;
			});
			inFlight.add(promise);
			void promise.finally(() => { inFlight.delete(promise); runControllers.delete(executionId); }).catch(() => undefined);
			if (params.background) {
				void promise.then((result) => {
					if (generation !== sessionGeneration) return;
					notifyRun(runId, result);
					if (!activeBatch && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) renderFleet();
				}).catch((error) => {
					if (generation !== sessionGeneration) return;
					pi.sendMessage({ customType: "herdr-subagents-run", content: `Subagent run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
				});
				return { content: [{ type: "text" as const, text: `Subagent run queued: ${runId}` }], details: { runId, status: "queued", background: true } };
			}
			const result = await promise;
			if (!activeBatch && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) { fleetSelection.reset(); renderFleet(); }
			return result;
		},

		renderCall(args, theme) {
			if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("herdr_subagents list")), 0, 0);
			if (args.action === "respond") return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents respond"))} ${theme.fg("muted", String(args.runId))}`, 0, 0);
			if (args.tasks) return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents"))} ${theme.fg("accent", `${args.tasks.length} tasks`)}${theme.fg("muted", ` · concurrency ${args.concurrency ?? "default"}`)}`, 0, 0);
			const agent = args.agent || "worker";
			const label = args.label ? ` · ${String(args.label)}` : "";
			const prompt = args.prompt ? String(args.prompt).replace(/\s+/g, " ") : "...";
			const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
			return new Text(`${theme.fg("toolTitle", theme.bold("herdr_subagents"))} ${theme.fg("accent", agent)}${theme.fg("muted", label)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const batch = result.details as HerdrSubagentsBatchDetails | undefined;
			if (batch?.tasks && "effectiveConcurrency" in batch) {
				const container = new Container();
				const color = isPartial ? "warning" : batch.ok ? "success" : "error";
				container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(batch.label))} ${theme.fg(color, batch.status)} · ${batch.tasks.length} settled · concurrency ${batch.effectiveConcurrency}`, 0, 0));
				for (const task of batch.tasks) container.addChild(new Text(`${task.status === "completed" ? "✓" : "✗"} ${task.name}: ${task.summary}`, 0, 0));
				return container;
			}
			const details = result.details as HerdrSubagentsDetails | undefined;
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

	pi.registerCommand("herdr-subagents", {
		description: "Inspect effective subagent agents, models, and settings",
		getArgumentCompletions: (prefix) => ["active", "history", "agents", "models", "settings", "focus "].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const section = args.trim() || "active";
			if (section === "active") {
				if (!activeBatch) { ctx.ui.notify("No active Subagent run.", "info"); return; }
				ctx.ui.notify(activeRunText(activeBatch), "info");
				return;
			}
			if (section === "history") {
				ctx.ui.notify(historyText(await listSubagentHistory(ctx.cwd)), "info");
				return;
			}
			if (section.startsWith("focus ")) {
				const focused = await focusActiveTask(activeBatch, Number(section.slice(6).trim()), herdr);
				if (!focused) ctx.ui.notify("That task is not active in a Herdr pane.", "warning");
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
			ctx.ui.notify("Usage: /herdr-subagents active|history|focus <task-number>|agents|models|settings", "warning");
		},
	});
}

export default registerHerdrSubagents;
