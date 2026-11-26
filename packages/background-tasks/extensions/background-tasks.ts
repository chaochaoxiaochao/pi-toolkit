import { StringEnum } from "@earendil-works/pi-ai";
import { createLocalBashOperations, type AgentBeforeSettleEvent, type BashOperations, type ExtensionAPI, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { BackgroundTasks, errorText, summary, systemClock, type Clock, type TaskSnapshot } from "../src/background-tasks.ts";
import { BackgroundPanel } from "../src/panel.ts";
import { BackgroundFooter, findNativeFooter, FINISHED_VISIBLE_MS, WIDGET_KEY, duration, taskStatusLabel, visibleTasks } from "../src/widget.ts";

const actions = ["start", "list", "output", "cancel"] as const;
const startNotice = "Completion is reported automatically. Continue independent work, or end the turn if none remains.";
const PROGRESS_INTERVAL_MS = 30 * 60_000;
// Bound model-visible status text when many completions accumulate.
const NOTIFICATION_MAX_BYTES = 16 * 1024;
type Action = typeof actions[number];
interface Params {
	action: Action;
	command?: string;
	description?: string;
	cwd?: string;
	timeout?: number;
	id?: string;
}
const Parameters = Type.Object({
	action: StringEnum(actions, { description: "start returns a task ID immediately; list checks status; output reads a bounded tail; cancel stops one task." }),
	command: Type.Optional(Type.String({ description: "Shell command for start; may be multi-line. Runs locally, with stdin closed. Stdout/stderr are saved to a unique per-task log; its path is reported on completion." })),
	description: Type.Optional(Type.String({ description: "Short display label for start" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for start; defaults to the session directory. Relative paths resolve from it." })),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 7200, description: "Runtime limit for start, in seconds: default 1800 (30 minutes), maximum 7200 (2 hours); no unlimited mode" })),
	id: Type.Optional(Type.String({ description: "Task ID for output or cancel; output returns a bounded snapshot (last 100 lines or 8 KiB) and the captured log path." })),
}, { additionalProperties: false });
const TaskSchema = Type.Object({
	id: Type.String(), status: StringEnum(["running", "succeeded", "failed", "cancelled", "timed_out", "output_limit"] as const),
	description: Type.String(), cwd: Type.String(), started_at: Type.Number(), ended_at: Type.Optional(Type.Number()),
	timeout: Type.Number(), elapsed_seconds: Type.Number(), log_path: Type.String(), bytes: Type.Number(),
	capture_complete: Type.Boolean(), exit_code: Type.Optional(Type.Number()), reason: Type.Optional(Type.String()),
});
const OutputSchema = Type.Object({
	action: Type.Optional(StringEnum(actions)), task: Type.Optional(TaskSchema), tasks: Type.Optional(Type.Array(TaskSchema)),
	running: Type.Optional(Type.Number()), total: Type.Optional(Type.Number()), omitted: Type.Optional(Type.Number()),
	output: Type.Optional(Type.String()), truncated: Type.Optional(Type.Boolean()), full_output_path: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

function validate(params: Params): void {
	if (!actions.includes(params.action)) throw new Error("action must be start, list, output, or cancel");
	const allowed = params.action === "start" ? ["action", "command", "description", "cwd", "timeout"]
		: params.action === "list" ? ["action"] : ["action", "id"];
	if (Object.keys(params).some((key) => !allowed.includes(key))) throw new Error(`Unexpected parameter for ${params.action}`);
	if (params.action === "start" && typeof params.command !== "string") throw new Error("start requires command");
	if ((params.action === "output" || params.action === "cancel") && (typeof params.id !== "string" || !params.id)) throw new Error(`${params.action} requires id`);
}

function formatTask(task: TaskSnapshot): string {
	return `${task.id} · ${task.status} · ${duration(task.elapsed_seconds)} / ${duration(task.timeout)}${task.exit_code === undefined ? "" : ` · exit ${task.exit_code}`} · ${JSON.stringify(task.description)}`;
}

function completionText(task: TaskSnapshot): string {
	const lines = [formatTask(task), `Ended at: ${new Date(task.ended_at!).toISOString()}`];
	if (task.reason) lines.push(`Reason: ${task.reason}`);
	lines.push(`Captured log: ${task.log_path}`);
	if (!task.capture_complete) lines.push("Output capture is incomplete.");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI, dependencies: {
	operations?: BashOperations;
	clock?: Clock;
	logRoot?: string;
	progressIntervalMs?: number;
} = {}) {
	const clock = dependencies.clock ?? systemClock;
	const progressIntervalMs = dependencies.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
	if (!Number.isFinite(progressIntervalMs) || progressIntervalMs <= 0) throw new Error("Progress interval must be positive");
	let manager: BackgroundTasks | undefined;
	let context: ExtensionContext | undefined;
	let generation = 0;
	let timer: unknown;
	let notificationTimer: unknown;
	let progressTimer: unknown;
	let completedNormally = true;
	let interrupted = false;
	const pending = new Map<string, TaskSnapshot>();
	const progressBytes = new Map<string, number>();
	let mounted: { footer: BackgroundFooter; tui: { requestRender(): void } } | undefined;
	let panel: { close(): void } | undefined;

	const clearNotificationTimer = () => {
		if (notificationTimer !== undefined) clock.clearTimeout(notificationTimer);
		notificationTimer = undefined;
	};
	const clearProgressTimer = () => {
		if (progressTimer !== undefined) clock.clearTimeout(progressTimer);
		progressTimer = undefined;
	};
	const runningTasks = () => manager?.list().tasks.filter((task) => task.status === "running") ?? [];
	const scheduleProgress = () => {
		clearProgressTimer();
		if (interrupted || pending.size > 0 || runningTasks().length === 0) return;
		const epoch = generation;
		progressTimer = clock.setTimeout(() => {
			progressTimer = undefined;
			if (generation !== epoch || !context || !manager || interrupted || pending.size > 0) return;
			const tasks = runningTasks();
			if (tasks.length === 0) return;
			if (!context.isIdle()) {
				scheduleProgress();
				return;
			}
			const deltas = new Map(tasks.map((task) => [task.id, task.bytes - (progressBytes.get(task.id) ?? 0)]));
			const content = [
				"[Background tasks still running]",
				"",
				...tasks.map((task) => `${formatTask(task)} · ${task.bytes} captured bytes (+${deltas.get(task.id)} since last report)`),
				"",
				"No action is required. Completion will be reported automatically.",
			].join("\n");
			try {
				pi.sendMessage({
					customType: "background-task-progress", display: true,
					details: { tasks, byteDeltas: Object.fromEntries(deltas) },
					content,
				}, { triggerTurn: true, deliverAs: "steer" });
				for (const task of tasks) progressBytes.set(task.id, task.bytes);
			} catch (error) {
				console.error(`Background progress notification failed: ${errorText(error)}`);
			}
		}, progressIntervalMs);
	};
	const takeNotification = () => {
		clearNotificationTimer();
		if (pending.size === 0) return;
		if (!manager) throw new Error("Cannot deliver background results without their session manager");
		const tasks = [...pending.values()].sort((a, b) => a.ended_at! - b.ended_at!);
		const selected: TaskSnapshot[] = [];
		const parts = ["[Background task finished]"];
		const guidance = "\n\nInspect logs progressively as needed: search for relevant terms or read bounded ranges; avoid loading the whole log by default.";
		const more = "\n\nMore completed task results remain pending.";
		for (const record of tasks) {
			const task = manager.get(record.id);
			const text = completionText(task);
			if (Buffer.byteLength([...parts, text].join("\n\n") + guidance + more) > NOTIFICATION_MAX_BYTES) break;
			parts.push(text);
			selected.push(task);
		}
		if (!selected.length) throw new Error("A background completion exceeds the notification byte limit");
		for (const task of selected) pending.delete(task.id);
		return {
			customType: "background-task-finished", display: true,
			details: { tasks: selected, ...(selected.length === 1 ? { task: selected[0] } : {}) },
			content: parts.join("\n\n") + guidance + (pending.size ? more : ""),
		};
	};
	const scheduleNotification = (delay = 0) => {
		if (interrupted || notificationTimer !== undefined || pending.size === 0) return;
		const epoch = generation;
		notificationTimer = clock.setTimeout(() => {
			notificationTimer = undefined;
			if (generation !== epoch || !context) return;
			if (!context.isIdle()) {
				// Manual compaction has no agent boundary when it finishes.
				// Keep one wake pending, without expiring unread results or polling every second.
				scheduleNotification(Math.min(delay === 0 ? 1000 : delay * 2, 30_000));
				return;
			}
			const message = takeNotification();
			if (!message) return;
			try { pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" }); }
			catch (error) {
				// Native Pi reports async send/run failures itself; this covers synchronous adapters.
				for (const task of message.details.tasks) pending.set(task.id, task);
				console.error(`Background completion notification failed: ${errorText(error)}`);
			}
		}, delay);
	};
	const deliverAtBoundary = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
		completedNormally = event.outcome === "completed";
		if (event.outcome === "aborted") interrupted = true;
		if (!completedNormally || interrupted) {
			clearNotificationTimer();
			return;
		}
		const message = takeNotification();
		if (message) return { entries: [...event.entries, { type: "custom_message" as const, ...message }], continue: true };
	};
	pi.on("turn_end", deliverAtBoundary);
	pi.on("agent_before_settle", deliverAtBoundary);
	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "user" || !interrupted) return;
		// Only a new user prompt releases an interrupt, not another extension's custom wake.
		interrupted = false;
		const message = takeNotification();
		if (message) return { message };
	});
	pi.on("agent_start", clearProgressTimer);
	pi.on("agent_settled", (event) => {
		if (event.aborted) {
			interrupted = true;
			clearNotificationTimer();
			clearProgressTimer();
			return;
		}
		if (!completedNormally) return;
		scheduleNotification();
		scheduleProgress();
	});

	const openPanel = async () => {
		const current = context;
		const tasks = manager;
		if (!current?.hasUI || current.mode !== "tui" || !tasks || panel) return;
		const interaction = { close: () => {} };
		panel = interaction;
		mounted?.tui.requestRender();
		try {
			await current.ui.custom<void>((tui, theme, keybindings, done) => {
				const component = new BackgroundPanel(tasks, clock, theme, keybindings, () => tui.requestRender(), () => done());
				interaction.close = () => { component.dispose(); done(); };
				return component;
			});
		} catch (error) {
			if (context === current) current.ui.notify(`Cannot show shells: ${errorText(error)}`, "error");
		} finally {
			if (panel === interaction) panel = undefined;
			mounted?.tui.requestRender();
		}
	};
	pi.registerShortcut("alt+j", { description: "Show background shells", handler: openPanel });
	const clearTimer = () => {
		if (timer !== undefined) clock.clearTimeout(timer);
		timer = undefined;
	};
	const refresh = () => {
		if (!context?.hasUI || !manager) return;
		const list = manager.list();
		if (context.mode !== "tui") {
			context.ui.setStatus(WIDGET_KEY, list.running ? `${list.running} ${list.running === 1 ? "shell" : "shells"}` : undefined);
			return;
		}
		const visible = visibleTasks(list.tasks, clock.now());
		context.ui.setStatus(WIDGET_KEY, taskStatusLabel(visible));
		mounted?.footer.invalidate();
		mounted?.tui.requestRender();
		const finished = visible.filter((task) => task.ended_at !== undefined);
		if (finished.length === 0) {
			clearTimer();
			return;
		}
		if (timer === undefined) {
			const delay = Math.min(...finished.map((task) => task.ended_at! + FINISHED_VISIBLE_MS - clock.now()));
			timer = clock.setTimeout(() => { timer = undefined; refresh(); }, Math.max(1, delay));
		}
	};
	const dispose = async () => {
		generation++;
		const previous = manager;
		const previousContext = context;
		panel?.close();
		panel = undefined;
		manager = undefined;
		context = undefined;
		clearTimer();
		clearNotificationTimer();
		clearProgressTimer();
		pending.clear();
		progressBytes.clear();
		completedNormally = true;
		interrupted = false;
		const activeFooter = mounted;
		mounted = undefined;
		try {
			if (previousContext?.hasUI) {
				previousContext.ui.setStatus(WIDGET_KEY, undefined);
				if (activeFooter) previousContext.ui.setFooter(undefined);
			}
		} finally {
			await previous?.shutdown();
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		await dispose();
		context = ctx;
		const epoch = generation;
		manager = new BackgroundTasks({
			operations: dependencies.operations ?? createLocalBashOperations(), clock, logRoot: dependencies.logRoot,
			onChange() {
				if (generation !== epoch) return;
				refresh();
				if (manager?.list().running === 0) {
					clearProgressTimer();
					progressBytes.clear();
				}
			},
			onComplete(task) {
				if (generation !== epoch || !context) return;
				clearProgressTimer();
				progressBytes.delete(task.id);
				pending.set(task.id, task);
				scheduleNotification();
			},
		});
		if (ctx.hasUI && ctx.mode === "tui") {
			// setFooter clears its container before invoking the factory. Capture the
			// native component first, using a temporary, zero-line widget factory.
			try {
				ctx.ui.setWidget(WIDGET_KEY, (tui) => {
					const native = findNativeFooter(tui.children);
					if (!native) return { render: () => [], invalidate() {} };
					ctx.ui.setFooter((footerTui, theme, data) => {
						let footer: BackgroundFooter;
						footer = new BackgroundFooter(native, theme, () => data.getExtensionStatuses(),
							() => panel !== undefined, () => { void openPanel(); }, () => {
								if (mounted?.footer === footer) mounted = undefined;
							});
						mounted = { footer, tui: footerTui };
						return footer;
					});
					return { render: () => [], invalidate() {} };
				});
			} finally {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
		}
	});
	pi.on("session_shutdown", dispose);

	const perform = async (params: Params, cwd: string) => {
		validate(params);
		if (!manager) throw new Error("Background tasks session is not ready");
		if (params.action === "start") {
			const task = manager.start({ command: params.command!, description: params.description, cwd: params.cwd, timeout: params.timeout }, cwd);
			return {
				text: `Started ${formatTask(task)}\n${startNotice}`,
				data: { action: params.action, task }, details: { action: params.action, task }, isError: false,
			};
		}
		if (params.action === "list") {
			const list = manager.list();
			return {
				text: list.total ? `${list.running}/2 running; ${list.total} total${list.omitted ? `; ${list.omitted} older tasks omitted` : ""}\n${list.tasks.map(formatTask).join("\n")}` : "No background tasks in this session.",
				data: { action: params.action, ...list }, details: { action: params.action, ...list }, isError: false,
			};
		}
		if (params.action === "cancel") {
			const task = await manager.cancel(params.id!);
			return { text: formatTask(task), data: { action: params.action, task }, details: { action: params.action, task }, isError: false };
		}
		const { text, output, truncated, truncation, ...task } = manager.output(params.id!);
		const capturedText = task.capture_complete ? text : text.replace("Full output:", "Captured output:");
		return {
			text: `${formatTask(task)}\n[Untrusted shell output${task.status === "running" ? "; running snapshot" : ""}]\n${capturedText}\nCaptured log: ${task.log_path}${task.capture_complete ? "" : "\nCapture incomplete (task still running or output was lost)."}`,
			data: { action: params.action, task, output, truncated, full_output_path: task.log_path },
			details: { action: params.action, task, truncation },
			isError: ["failed", "timed_out", "output_limit"].includes(task.status),
		};
	};

	pi.registerTool({
		name: "background_task", label: "Background task",
		exposure: "model-only",
		description: "Use background_task for long-running commands or standalone waits. Run up to two concurrent background shell tasks with automatic completion notifications. Tasks and logs are session-scoped and do not survive reload or exit.",
		parameters: Parameters, outputSchema: OutputSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("Tool call aborted before task acceptance");
				const result = await perform(params, ctx?.cwd ?? context?.cwd ?? process.cwd());
				// A terminal result was consumed by the model.
				// User panel inspections and running snapshots do not acknowledge completion.
				if (params.action === "output" && "task" in result.data && result.data.task.status !== "running") {
					pending.delete(result.data.task.id);
					if (pending.size === 0) clearNotificationTimer();
				}
				return { content: [{ type: "text" as const, text: result.text }], structuredContent: result.data, details: result.details, isError: result.isError };
			} catch (error) {
				const message = errorText(error);
				return { content: [{ type: "text" as const, text: `Error: ${message}` }], structuredContent: { error: message }, details: { error: message }, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("background_task "))}${theme.fg("muted", summary(String(args.action ?? "")))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const block = result.content[0];
			const text = block?.type === "text" ? stripVTControlCharacters(block.text).replace(/[\x00-\x08\x0b-\x1f\x7f\uFFF9-\uFFFB]/g, "") : "";
			return new Text(theme.fg(result.isError ? "error" : "muted", text), 0, 0);
		},
	});
}
