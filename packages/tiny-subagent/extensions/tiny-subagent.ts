import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSubagentConfiguration } from "../src/config.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";
import { activeRunText, activityCounts, focusActiveTask } from "../src/monitor.ts";
import { RunDispatcher } from "../src/dispatcher.ts";
import { historyText, listSubagentHistory } from "../src/history.ts";
import { loadQueuedRuns, persistQueuedRun, removeQueuedRun } from "../src/queued-runs.ts";
import { reconcileSubagentRuns } from "../src/reconcile.ts";
import { continueQueuedRun } from "../src/continue-run.ts";
import { executeTinySubagent, type TinySubagentBatchDetails, type TinySubagentDetails, type TinySubagentToolParams } from "../src/tool.ts";

const ACTIONS = ["list"] as const;
const TinySubagentParams = Type.Union([
	Type.Object({
		action: StringEnum(ACTIONS, { description: "Discover package-local personas before execution." }),
	}),
	Type.Object({
		action: StringEnum(["respond"] as const),
		runId: Type.String({ minLength: 1 }),
		answer: Type.String({ minLength: 1 }),
		task: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	Type.Object({ action: StringEnum(["history"] as const) }),
	Type.Object({ action: StringEnum(["cleanup"] as const), runId: Type.String({ minLength: 1 }) }),
	Type.Object({ action: StringEnum(["resume"] as const), runId: Type.String({ minLength: 1 }), task: Type.Integer({ minimum: 1 }), prompt: Type.String({ minLength: 1 }) }),
	Type.Object({
		prompt: Type.String({ minLength: 1, description: "One self-contained task for the subagent." }),
		agent: Type.Optional(Type.String({ minLength: 1, description: "Persona name selected from action=list. Defaults to worker." })),
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 48, description: "Short label for the Herdr run tab." })),
		model: Type.Optional(Type.String({ minLength: 1, description: "Optional Pi model, for example provider/model:high." })),
	}),
	Type.Object({
		tasks: Type.Array(Type.Object({
			name: Type.String({ minLength: 1, maxLength: 48 }),
			prompt: Type.String({ minLength: 1 }),
			agent: Type.Optional(Type.String({ minLength: 1 })),
			model: Type.Optional(Type.String({ minLength: 1 })),
		}), { minItems: 1 }),
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
		concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
		background: Type.Optional(Type.Boolean()),
	}),
]);

const packageAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	let activeBatch: TinySubagentBatchDetails | undefined;
	const herdr = new CliHerdrAutomation();
	const dispatcher = new RunDispatcher();
	const notifyRun = (runId: string, result: { details: unknown; content?: Array<{ type: string; text?: string }> }) => {
		const details = result.details as Partial<TinySubagentBatchDetails> & { errorMessage?: string };
		if (!details.tasks || !details.documents || !details.status) {
			const error = details.errorMessage ?? result.content?.find((item) => item.type === "text")?.text ?? "Unknown Subagent failure.";
			pi.sendMessage({ customType: "tiny-subagents-run", content: `Subagent run ${runId} failed: ${error}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		const lines = [`Subagent run ${runId} ${details.status}: ${details.summary}`, ...details.tasks.map((task) => `- ${task.name}: ${task.summary}`)];
		if (details.documents.length) lines.push("Documents:", ...details.documents.map((document) => `- ${document.description}: ${document.path}`));
		pi.sendMessage({ customType: "tiny-subagents-run", content: lines.join("\n"), display: true, details: { runId, status: details.status } }, { triggerTurn: true, deliverAs: "followUp" });
	};

	pi.on("session_shutdown", () => { dispatcher.pause(); });
	pi.on("session_start", async (_event, ctx) => {
		dispatcher.pause();
		const reconciliation = await reconcileSubagentRuns(ctx.cwd, herdr);
		const known = new Set([dispatcher.snapshot().activeRunId, ...dispatcher.snapshot().queuedRunIds].filter(Boolean));
		for (const queued of await loadQueuedRuns(ctx.cwd)) {
			if (known.has(queued.runId)) continue;
			void dispatcher.submit(queued.runId, async () => {
				await removeQueuedRun(ctx.cwd, queued.runId);
				const result = await executeTinySubagent(queued.params, undefined, undefined, ctx, { agentsDirectory: packageAgentsDir });
				notifyRun(queued.runId, result);
				return result;
			}).catch((error) => notifyRun(queued.runId, { details: { errorMessage: error instanceof Error ? error.message : String(error) } }));
		}
		const continuePersistedTasks = async () => {
			for (const run of await listSubagentHistory(ctx.cwd)) if (run.status === "queued") await continueQueuedRun(run.recordDirectory, herdr);
		};
		if (reconciliation.liveTasks === 0) { await continuePersistedTasks(); dispatcher.resume(); }
		else {
			ctx.ui.notify(`${reconciliation.liveTasks} Subagent task(s) are still running in Herdr; queued dispatch remains paused.`, "info");
			void (async () => {
				while ((await reconcileSubagentRuns(ctx.cwd, herdr)).liveTasks > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
				await continuePersistedTasks();
				dispatcher.resume();
			})();
		}
	});

	pi.registerTool({
		name: "tiny_subagents",
		label: "Tiny Subagent",
		description: "Run one focused task or an ordered bounded-concurrency batch synchronously in a visible Herdr tab. Returns compact reports while complete results and Pi sessions stay in project-local records.",
		promptSnippet: "Run focused work in visible Herdr subagents",
		promptGuidelines: ["Call action=list once before the first execution. Submit one prompt or an ordered tasks list; use concurrency only for independent read-only tasks. Foreground calls block until the run settles; background calls return a run ID immediately."],
		parameters: TinySubagentParams,

		async execute(_toolCallId, params: TinySubagentToolParams, signal, onUpdate, ctx) {
			if (!params.action && params.prompt && !params.tasks) {
				params.tasks = [{ name: params.label?.trim() || params.agent?.trim() || "task", prompt: params.prompt, agent: params.agent, model: params.model }];
				params.label ??= params.agent?.trim() || "task";
			}
			const runSignal = params.background ? undefined : signal;
			const executeRun = async () => await executeTinySubagent(params, runSignal, (update) => {
				const details = update.details as TinySubagentBatchDetails | undefined;
				if (details?.activity) {
					activeBatch = details;
					const counts = activityCounts(details);
					ctx.ui.setWidget("tiny-subagents", [`Subagents · ${details.label}`, `running ${counts.running} · queued ${counts.queued} · blocked ${counts.blocked} · failed ${counts.failed} · completed ${counts.completed} · queued runs ${dispatcher.snapshot().queuedRunIds.length}`]);
				}
				if (!params.background) onUpdate?.(update);
			}, ctx, { agentsDirectory: packageAgentsDir });
			if (!params.tasks) {
				const result = await executeRun();
				if (params.action === "respond" && (result.details as { status?: string }).status !== "blocked") { activeBatch = undefined; ctx.ui.setWidget("tiny-subagents", undefined); }
				return result;
			}
			const runId = randomUUID();
			params.runId = runId;
			if (params.background) await persistQueuedRun(ctx.cwd, runId, params);
			const promise = dispatcher.submit(runId, async () => {
				if (params.background) await removeQueuedRun(ctx.cwd, runId);
				const result = await executeRun();
				const details = result.details as TinySubagentBatchDetails;
				activeBatch = details.status === "blocked" ? details : undefined;
				if (activeBatch) {
					const counts = activityCounts(activeBatch);
					ctx.ui.setWidget("tiny-subagents", [`Subagents · ${activeBatch.label}`, `running ${counts.running} · queued ${counts.queued} · blocked ${counts.blocked} · failed ${counts.failed} · completed ${counts.completed}`]);
				}
				return result;
			});
			if (params.background) {
				ctx.ui.setWidget("tiny-subagents", [`Subagent run ${runId.slice(0, 8)} queued`, `queued runs ${dispatcher.snapshot().queuedRunIds.length}`]);
				void promise.then((result) => {
					notifyRun(runId, result);
					if (!activeBatch && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) ctx.ui.setWidget("tiny-subagents", undefined);
				}).catch((error) => {
					pi.sendMessage({ customType: "tiny-subagents-run", content: `Subagent run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, display: true, details: { runId, status: "failed" } }, { triggerTurn: true, deliverAs: "followUp" });
				});
				return { content: [{ type: "text" as const, text: `Subagent run queued: ${runId}` }], details: { runId, status: "queued", background: true } };
			}
			const result = await promise;
			if (!activeBatch && !dispatcher.snapshot().activeRunId && dispatcher.snapshot().queuedRunIds.length === 0) ctx.ui.setWidget("tiny-subagents", undefined);
			return result;
		},

		renderCall(args, theme) {
			if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("tiny_subagents list")), 0, 0);
			if (args.action === "respond") return new Text(`${theme.fg("toolTitle", theme.bold("tiny_subagents respond"))} ${theme.fg("muted", String(args.runId))}`, 0, 0);
			if (args.tasks) return new Text(`${theme.fg("toolTitle", theme.bold("tiny_subagents"))} ${theme.fg("accent", `${args.tasks.length} tasks`)}${theme.fg("muted", ` · concurrency ${args.concurrency ?? "default"}`)}`, 0, 0);
			const agent = args.agent || "worker";
			const label = args.label ? ` · ${String(args.label)}` : "";
			const prompt = args.prompt ? String(args.prompt).replace(/\s+/g, " ") : "...";
			const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
			return new Text(`${theme.fg("toolTitle", theme.bold("tiny_subagents"))} ${theme.fg("accent", agent)}${theme.fg("muted", label)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const batch = result.details as TinySubagentBatchDetails | undefined;
			if (batch?.tasks && "effectiveConcurrency" in batch) {
				const container = new Container();
				const color = isPartial ? "warning" : batch.ok ? "success" : "error";
				container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(batch.label))} ${theme.fg(color, batch.status)} · ${batch.tasks.length} settled · concurrency ${batch.effectiveConcurrency}`, 0, 0));
				for (const task of batch.tasks) container.addChild(new Text(`${task.status === "completed" ? "✓" : "✗"} ${task.name}: ${task.summary}`, 0, 0));
				return container;
			}
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
			ctx.ui.notify("Usage: /subagents active|history|focus <task-number>|agents|models|settings", "warning");
		},
	});
}
