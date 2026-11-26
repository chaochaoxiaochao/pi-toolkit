import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Scheduler, systemClock, type ScheduleSnapshot } from "../src/scheduler.ts";

const ACTIONS = ["add", "list", "cancel", "clear"] as const;

const Params = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "Action to perform: add, list, cancel, or clear",
	}),
	every: Type.Optional(Type.String({ description: "Repeat interval for add, for example 30s, 5m, or 1h30m" })),
	prompt: Type.Optional(Type.String({ description: "Prompt sent to the main agent on each interval for add" })),
	id: Type.Optional(Type.String({ description: "Schedule ID for cancel. Omit when only one schedule is active" })),
});

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatList(schedules: ScheduleSnapshot[]): string {
	if (schedules.length === 0) return "No active schedules.";
	return schedules.map((item) =>
		`${item.id} · every ${item.every} · next ${formatTime(item.nextRunAt)}${item.pending ? " · prompt pending" : ""}\n  ${item.prompt}`,
	).join("\n");
}

type ScheduleAction = (typeof ACTIONS)[number];

function parseCommand(input: string): { action: ScheduleAction; every?: string; prompt?: string; id?: string } {
	const text = input.trim();
	if (!text || text === "list") return { action: "list" };
	const [action, first, ...rest] = text.split(/\s+/);
	if (action === "add") return { action, every: first, prompt: rest.join(" ") };
	if (action === "cancel") return { action, id: first };
	if (action === "clear") return { action };
	if (action === "list") throw new Error("usage: /schedule [prompt] | add <interval> <prompt> | list | cancel [id] | clear");
	if (action === "trigger") throw new Error("trigger is no longer supported");
	return { action: "add", every: "20s", prompt: text };
}

function argumentCompletions(prefix: string, schedules: ScheduleSnapshot[]) {
	const [action = "", idPrefix, ...extra] = prefix.trimStart().split(/\s+/);
	if (extra.length > 0) return null;
	if (idPrefix === undefined) {
		if (ACTIONS.some((item) => item === action)) return [];
		const items = ACTIONS
			.filter((item) => item.startsWith(action))
			.map((item) => ({ value: item, label: item }));
		return items.length > 0 ? items : null;
	}
	if (action !== "cancel") return null;
	const items = schedules
		.filter((schedule) => schedule.id.startsWith(idPrefix))
		.map((schedule) => ({ value: `cancel ${schedule.id}`, label: schedule.id, description: `${schedule.every} · ${schedule.prompt}` }));
	return items.length > 0 ? items : null;
}

const WIDGET_KEY = "scheduler";

export class ScheduleWidget {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly getSchedules: () => ScheduleSnapshot[];
	private readonly theme: Theme;

	constructor(getSchedules: () => ScheduleSnapshot[], theme: Theme) {
		this.getSchedules = getSchedules;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const schedules = this.getSchedules();
		this.cachedLines = [
			truncateToWidth(this.theme.fg("accent", `⏱ ${schedules.length} active schedule${schedules.length === 1 ? "" : "s"}`), width),
			...schedules.map((item) => {
				const marker = item.pending ? this.theme.fg("warning", "●") : this.theme.fg("dim", "○");
				const state = item.pending ? " · pending" : "";
				return truncateToWidth(`  ${marker} ${this.theme.fg("accent", item.id)} · ${item.every} · next ${formatTime(item.nextRunAt)}${state} · ${this.theme.fg("text", item.prompt)}`, width);
			}),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

interface MountedWidget {
	component: ScheduleWidget;
	tui: { requestRender(): void };
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1") return;
	let context: ExtensionContext | undefined;
	let mountedWidget: MountedWidget | undefined;

	const refreshUI = () => {
		if (!context?.hasUI) return;
		const schedules = scheduler.list();
		if (context.mode !== "tui") {
			const next = schedules[0];
			context.ui.setStatus(WIDGET_KEY, next ? `⏱ ${schedules.length} schedule${schedules.length === 1 ? "" : "s"} · next ${formatTime(next.nextRunAt)}` : undefined);
			return;
		}
		context.ui.setStatus(WIDGET_KEY, undefined);
		if (schedules.length === 0) {
			if (mountedWidget) {
				context.ui.setWidget(WIDGET_KEY, undefined);
				mountedWidget.tui.requestRender();
				mountedWidget = undefined;
			}
			return;
		}
		if (mountedWidget) {
			mountedWidget.component.invalidate();
			mountedWidget.tui.requestRender();
			return;
		}
		context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const component = new ScheduleWidget(() => scheduler.list(), theme);
			mountedWidget = { component, tui };
			return component;
		}, { placement: "aboveEditor" });
	};

	const scheduler = new Scheduler({
		clock: systemClock,
		onChange: refreshUI,
		onTrigger(schedule) {
			pi.sendMessage({
				customType: "scheduler-trigger",
				content: `[Scheduled prompt: ${schedule.id}]\n${schedule.prompt}`,
				display: true,
				details: { scheduleId: schedule.id, every: schedule.every },
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	const perform = (params: { action: ScheduleAction; every?: string; prompt?: string; id?: string }) => {
		if (params.action === "add") {
			if (!params.every || !params.prompt) throw new Error("add requires every and prompt");
			const item = scheduler.add(params.every, params.prompt);
			return `Created ${item.id}: every ${item.every}; next ${formatTime(item.nextRunAt)}.`;
		}
		if (params.action === "list") return formatList(scheduler.list());
		if (params.action === "clear") {
			const count = scheduler.clear();
			return count === 0 ? "No active schedules to clear." : `Cleared ${count} schedule${count === 1 ? "" : "s"}. Already queued prompts cannot be withdrawn.`;
		}
		let id = params.id;
		if (!id) {
			const schedules = scheduler.list();
			if (schedules.length === 0) throw new Error("No active schedules to cancel.");
			if (schedules.length > 1) throw new Error(`cancel requires id when multiple schedules are active: ${schedules.map((schedule) => schedule.id).join(", ")}`);
			id = schedules[0].id;
		}
		if (!scheduler.cancel(id)) throw new Error(`unknown schedule: ${id}`);
		return `Cancelled ${id}. Already queued prompts cannot be withdrawn.`;
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		refreshUI();
	});
	pi.on("message_start", async (event) => {
		if (event.message.role !== "custom" || event.message.customType !== "scheduler-trigger") return;
		const details = event.message.details as { scheduleId?: unknown } | undefined;
		if (typeof details?.scheduleId === "string") scheduler.acknowledge(details.scheduleId);
	});
	pi.on("agent_settled", async () => {
		// A queued follow-up can be cleared by Pi before it produces message_start.
		// Once the run is fully settled, any still-pending scheduler message is gone.
		scheduler.releaseUndelivered();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		scheduler.clear();
		if (ctx.hasUI) {
			ctx.ui.setStatus(WIDGET_KEY, undefined);
			if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		mountedWidget = undefined;
		context = undefined;
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description: "Manage recurring prompts for the current session.",
		parameters: Params,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params) {
			try {
				const text = perform(params);
				return { content: [{ type: "text" as const, text }], details: { ...params, schedules: scheduler.list() } };
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { ...params, error: text }, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("schedule "))}${theme.fg("muted", args.action)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const item = result.content[0];
			return new Text(theme.fg(result.isError ? "error" : "muted", item?.type === "text" ? item.text : ""), 0, 0);
		},
	});

	pi.registerCommand("schedule", {
		description: "Add, list, cancel, or clear session-scoped recurring prompts",
		getArgumentCompletions: (prefix) => argumentCompletions(prefix, scheduler.list()),
		handler: async (args, ctx) => {
			try {
				const text = perform(parseCommand(args));
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
