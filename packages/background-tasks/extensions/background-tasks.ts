import { StringEnum } from "@earendil-works/pi-ai";
import { createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { BackgroundTasks, errorText, summary, systemClock, type Clock, type TaskSnapshot } from "../src/background-tasks.ts";
import { BackgroundWidget, FINISHED_VISIBLE_MS, WIDGET_KEY, duration, visibleTasks } from "../src/widget.ts";

const actions = ["start", "list", "output", "cancel"] as const;
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
	action: StringEnum(actions, { description: "start returns a task ID immediately; list checks tasks; output reads a bash-limited snapshot; cancel stops one task" }),
	command: Type.Optional(Type.String({ description: "Shell command for start; may be multi-line. Runs locally, with stdin closed." })),
	description: Type.Optional(Type.String({ description: "Short display label for start" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for start; defaults to the session directory. Relative paths resolve from it." })),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 7200, description: "Runtime limit for start, in seconds: default 1800 (30 minutes), maximum 7200 (2 hours); no unlimited mode" })),
	id: Type.Optional(Type.String({ description: "Task ID for output or cancel; output shows the last 2000 lines or 50 KiB. Codemode receives up to 1 MiB, keeping head/tail if larger, plus a log path." })),
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
function parseCommand(input: string): Params {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || (parts.length === 1 && parts[0] === "list")) return { action: "list" };
	if (parts.length === 2 && (parts[0] === "output" || parts[0] === "cancel")) return { action: parts[0], id: parts[1] };
	throw new Error("usage: /bg [list | output <id> | cancel <id>]");
}

export default function (pi: ExtensionAPI, dependencies: { operations?: BashOperations; clock?: Clock; logRoot?: string } = {}) {
	const clock = dependencies.clock ?? systemClock;
	let manager: BackgroundTasks | undefined;
	let context: ExtensionContext | undefined;
	let generation = 0;
	let timer: unknown;
	let mounted: { widget: BackgroundWidget; tui: { requestRender(): void } } | undefined;

	const clearTimer = () => {
		if (timer !== undefined) clock.clearTimeout(timer);
		timer = undefined;
	};
	const refresh = () => {
		if (!context?.hasUI || !manager) return;
		const list = manager.list();
		if (context.mode !== "tui") {
			context.ui.setStatus(WIDGET_KEY, list.running ? `Background tasks ${list.running}/2` : undefined);
			return;
		}
		const visible = visibleTasks(list.tasks, clock.now());
		if (visible.length === 0) {
			clearTimer();
			if (mounted) {
				context.ui.setWidget(WIDGET_KEY, undefined);
				mounted.tui.requestRender();
				mounted = undefined;
			}
			return;
		}
		if (mounted) {
			mounted.widget.invalidate();
			mounted.tui.requestRender();
		} else {
			context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				const widget = new BackgroundWidget(() => manager?.list().tasks ?? [], clock, theme);
				mounted = { widget, tui };
				return widget;
			}, { placement: "aboveEditor" });
		}
		if (timer === undefined) {
			const delay = Math.min(1000, ...visible.filter((task) => task.ended_at !== undefined).map((task) => task.ended_at! + FINISHED_VISIBLE_MS - clock.now()));
			timer = clock.setTimeout(() => { timer = undefined; refresh(); }, Math.max(1, delay));
		}
	};
	const dispose = async () => {
		generation++;
		const previous = manager;
		const previousContext = context;
		manager = undefined;
		context = undefined;
		clearTimer();
		try {
			if (previousContext?.hasUI) {
				previousContext.ui.setStatus(WIDGET_KEY, undefined);
				if (previousContext.mode === "tui") previousContext.ui.setWidget(WIDGET_KEY, undefined);
			}
			mounted = undefined;
		} finally { await previous?.shutdown(); }
	};
	pi.on("session_start", async (_event, ctx) => {
		await dispose();
		context = ctx;
		const epoch = generation;
		manager = new BackgroundTasks({
			operations: dependencies.operations ?? createLocalBashOperations(), clock, logRoot: dependencies.logRoot,
			onChange() { if (generation === epoch) refresh(); },
			onComplete(task) {
				if (generation !== epoch || !context) return;
				pi.sendMessage({
					customType: "background-task-finished", display: true, details: { task },
					content: `[Background task finished]\n${formatTask(task)}${task.reason ? `\nReason: ${task.reason}` : ""}\nCaptured log: ${task.log_path}${task.capture_complete ? "" : "\nOutput capture is incomplete."}`,
				}, { triggerTurn: true, deliverAs: "followUp" });
			},
		});
	});
	pi.on("session_shutdown", dispose);

	const perform = async (params: Params, cwd: string) => {
		validate(params);
		if (!manager) throw new Error("Background tasks session is not ready");
		if (params.action === "start") {
			const task = manager.start({ command: params.command!, description: params.description, cwd: params.cwd, timeout: params.timeout }, cwd);
			return {
				text: `Started ${formatTask(task)}\nLog: ${task.log_path}\nAt most 2 tasks run at once. Tasks stop on session changes, reload, or exit; captured logs are then removed.`,
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
		description: "Start shell commands as background tasks and return task IDs immediately. Supports status, output, and cancellation; notifies the main agent on completion.",
		parameters: Parameters, outputSchema: OutputSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("Tool call aborted before task acceptance");
				const result = await perform(params, ctx?.cwd ?? context?.cwd ?? process.cwd());
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
	pi.registerCommand("bg", {
		description: "List background shell tasks, read output, or cancel a task",
		handler: async (args, ctx) => {
			try {
				const result = await perform(parseCommand(args), ctx.cwd);
				pi.sendMessage({ customType: "background-task-inspect", content: result.text, display: true, details: result.details }, { triggerTurn: false });
			} catch (error) { ctx.ui.notify(errorText(error), "error"); }
		},
	});
}
