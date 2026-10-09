import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Scheduler, systemClock, type ScheduleSnapshot } from "../src/scheduler.ts";

const Params = Type.Object({
	action: StringEnum(["add", "list", "trigger", "cancel"] as const),
	every: Type.Optional(Type.String({ description: "Interval for add, for example 30s, 5m, or 1h30m" })),
	prompt: Type.Optional(Type.String({ description: "Prompt delivered to the main agent on each trigger" })),
	id: Type.Optional(Type.String({ description: "Schedule ID for trigger or cancel" })),
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

function parseCommand(input: string): { action: "add" | "list" | "trigger" | "cancel"; every?: string; prompt?: string; id?: string } {
	const text = input.trim();
	if (!text || text === "list") return { action: "list" };
	const [action, first, ...rest] = text.split(/\s+/);
	if (action === "add") return { action, every: first, prompt: rest.join(" ") };
	if (action === "trigger" || action === "cancel") return { action, id: first };
	throw new Error("usage: /schedule add <interval> <prompt> | list | trigger <id> | cancel <id>");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1") return;
	let context: ExtensionContext | undefined;

	const refreshStatus = () => {
		if (!context?.hasUI) return;
		const schedules = scheduler.list();
		const next = schedules[0];
		context.ui.setStatus("scheduler", next ? `⏱ ${schedules.length} schedule${schedules.length === 1 ? "" : "s"} · next ${formatTime(next.nextRunAt)}` : undefined);
	};

	const scheduler = new Scheduler({
		clock: systemClock,
		onChange: refreshStatus,
		onTrigger(schedule, source) {
			pi.sendMessage({
				customType: "scheduler-trigger",
				content: `[Scheduled prompt: ${schedule.id}; source=${source}]\n${schedule.prompt}`,
				display: true,
				details: { scheduleId: schedule.id, source, every: schedule.every },
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	const perform = (params: { action: "add" | "list" | "trigger" | "cancel"; every?: string; prompt?: string; id?: string }) => {
		if (params.action === "add") {
			if (!params.every || !params.prompt) throw new Error("add requires every and prompt");
			const item = scheduler.add(params.every, params.prompt);
			return `Created ${item.id}: every ${item.every}; next ${formatTime(item.nextRunAt)}.`;
		}
		if (params.action === "list") return formatList(scheduler.list());
		if (!params.id) throw new Error(`${params.action} requires id`);
		if (params.action === "cancel") {
			if (!scheduler.cancel(params.id)) throw new Error(`unknown schedule: ${params.id}`);
			return `Cancelled ${params.id}. Already queued prompts cannot be withdrawn.`;
		}
		const result = scheduler.trigger(params.id);
		if (!result.ok) {
			if (result.reason === "already-pending") throw new Error(`${params.id} already has a pending prompt`);
			throw new Error(`unknown schedule: ${params.id}`);
		}
		return `Triggered ${params.id}; its regular next time is unchanged.`;
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		refreshStatus();
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
		if (ctx.hasUI) ctx.ui.setStatus("scheduler", undefined);
		context = undefined;
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description: "Manage session-scoped interval prompts for the main agent. Use add when the user asks the agent to check something repeatedly. Use trigger for one immediate check without changing the regular cadence. Schedules end with the current session.",
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
		description: "Add, list, trigger, or cancel session-scoped interval prompts",
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
