import assert from "node:assert/strict";
import registerScheduler from "../extensions/scheduler.ts";

const handlers = new Map();
const commands = new Map();
const messages = [];
const statuses = new Map();
let tool;
const widgets = new Map([["herdr-subagents", { render: () => ["Herdr Fleet"] }]]);
const widgetOptions = new Map([["herdr-subagents", { placement: "belowEditor" }]]);
let renderRequests = 0;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let nextTimer = 1;
const timers = new Map();
globalThis.setTimeout = (callback, delayMs) => {
	const id = nextTimer++;
	timers.set(id, { callback, delayMs });
	return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
function fireNextTimer() {
	const next = [...timers.entries()].sort(([left], [right]) => left - right)[0];
	assert.ok(next, "expected an active scheduler timer");
	timers.delete(next[0]);
	next[1].callback();
}
const pi = {
	on(name, handler) { handlers.set(name, handler); },
	registerTool(definition) { tool = definition; },
	registerCommand(name, definition) { commands.set(name, definition); },
	sendMessage(message, options) { messages.push({ message, options }); },
};
const childGuard = process.env.PI_HERDR_SUBAGENTS_CHILD;
delete process.env.PI_HERDR_SUBAGENTS_CHILD;
try {
	registerScheduler(pi);
} finally {
	if (childGuard === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	else process.env.PI_HERDR_SUBAGENTS_CHILD = childGuard;
}
const notifications = [];
const asAppMessage = ({ message }) => ({ ...message, role: "custom" });
const context = {
	hasUI: true,
	mode: "tui",
	ui: {
		setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
		setWidget(key, value, options) {
			if (value === undefined) {
				widgets.delete(key);
				widgetOptions.delete(key);
			} else {
				widgets.set(key, value({ requestRender() { renderRequests += 1; } }, { fg(_color, text) { return text; } }));
				widgetOptions.set(key, options);
			}
		},
		notify(message, level) { notifications.push({ message, level }); },
	},
};
await handlers.get("session_start")({}, context);
assert.ok(tool);
assert.ok(commands.has("schedule"));
const command = commands.get("schedule");
assert.equal(tool.description, "Manage recurring prompts for the current session.");
assert.deepEqual(tool.parameters.properties.action.enum, ["add", "list", "cancel", "clear"]);
assert.equal(tool.parameters.properties.action.description, "Action to perform: add, list, cancel, or clear");
assert.equal(tool.parameters.properties.every.description, "Repeat interval for add, for example 30s, 5m, or 1h30m");
assert.equal(tool.parameters.properties.prompt.description, "Prompt sent to the main agent on each interval for add");
assert.equal(tool.parameters.properties.id.description, "Schedule ID for cancel. Omit when only one schedule is active");
assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["add", "list", "cancel", "clear"]);
assert.deepEqual(command.getArgumentCompletions("c").map((item) => item.value), ["cancel", "clear"]);
assert.deepEqual(command.getArgumentCompletions("list"), []);
assert.equal(command.getArgumentCompletions("trigger"), null);
const emptyCancel = await tool.execute("empty-cancel", { action: "cancel" });
assert.equal(emptyCancel.isError, true);
assert.equal(emptyCancel.content[0].text, "Error: No active schedules to cancel.");

const add = await tool.execute("add", { action: "add", every: "1h", prompt: "Check CI" });
assert.match(add.content[0].text, /Created schedule-1/);
assert.equal(statuses.has("scheduler"), false, "scheduler no longer competes for footer status space");
assert.deepEqual(widgetOptions.get("scheduler"), { placement: "aboveEditor" });
assert.deepEqual(widgetOptions.get("herdr-subagents"), { placement: "belowEditor" });
assert.match(widgets.get("scheduler").render(100).join("\n"), /1 active schedule/);
assert.match(widgets.get("scheduler").render(100).join("\n"), /schedule-1 · 1h · next/);
assert.ok(widgets.has("herdr-subagents"), "Scheduler mounting preserves the Herdr Fleet widget");
assert.deepEqual(command.getArgumentCompletions("cancel "), [
	{ value: "cancel schedule-1", label: "schedule-1", description: "1h · Check CI" },
]);

fireNextTimer();
assert.equal(messages.length, 1);
assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
assert.equal(messages[0].message.content, "[Scheduled prompt: schedule-1]\nCheck CI");
await handlers.get("message_start")({ message: { role: "custom", customType: "other", details: { scheduleId: "schedule-1" } } });
fireNextTimer();
assert.equal(messages.length, 1, "unrelated custom messages do not acknowledge a schedule");
await handlers.get("message_start")({ message: asAppMessage(messages[0]) });
fireNextTimer();
assert.equal(messages.length, 2);
await command.handler("list", context);
assert.match(notifications.at(-1).message, /schedule-1/);

await handlers.get("agent_settled")({ aborted: false });
fireNextTimer();
assert.equal(messages.length, 3, "settlement releases a queued scheduler message that never reached message_start");
await handlers.get("message_start")({ message: asAppMessage(messages[2]) });
await command.handler("cancel", context);
assert.match(notifications.at(-1).message, /Already queued prompts cannot be withdrawn/);
assert.equal(statuses.has("scheduler"), false);
assert.equal(widgets.has("scheduler"), false, "removing the final schedule removes the multi-line widget");
assert.ok(widgets.has("herdr-subagents"), "Scheduler cleanup preserves the Herdr Fleet widget");

await tool.execute("multi-add-one", { action: "add", every: "2h", prompt: "Check deployment" });
await tool.execute("multi-add-two", { action: "add", every: "3h", prompt: "Check release" });
assert.match(widgets.get("scheduler").render(100).join("\n"), /2 active schedules/);
assert.match(widgets.get("scheduler").render(100).join("\n"), /schedule-2/);
assert.match(widgets.get("scheduler").render(100).join("\n"), /schedule-3/);
assert.deepEqual(command.getArgumentCompletions("cancel schedule-").map((item) => item.value), ["cancel schedule-2", "cancel schedule-3"]);
const ambiguousCancel = await tool.execute("ambiguous-cancel", { action: "cancel" });
assert.equal(ambiguousCancel.isError, true);
assert.match(ambiguousCancel.content[0].text, /cancel requires id when multiple schedules are active: schedule-2, schedule-3/);
await command.handler("cancel", context);
assert.equal(notifications.at(-1).level, "error");
await command.handler("cancel schedule-2", context);
assert.match(notifications.at(-1).message, /Cancelled schedule-2/);
const finalCancel = await tool.execute("final-cancel", { action: "cancel" });
assert.match(finalCancel.content[0].text, /Cancelled schedule-3/);
assert.equal(widgets.has("scheduler"), false);

await tool.execute("clear-add-one", { action: "add", every: "2h", prompt: "Check deployment" });
await tool.execute("clear-add-two", { action: "add", every: "3h", prompt: "Check release" });
await command.handler("clear", context);
assert.match(notifications.at(-1).message, /Cleared 2 schedules/);
assert.equal(timers.size, 0, "clear cancels every active timer");
assert.equal(widgets.has("scheduler"), false, "clear removes the widget");
assert.ok(widgets.has("herdr-subagents"), "clear does not remove Herdr Fleet");
const emptyClear = await tool.execute("empty-clear", { action: "clear" });
assert.equal(emptyClear.content[0].text, "No active schedules to clear.");
await tool.execute("shutdown-add", { action: "add", every: "4h", prompt: "Check shutdown" });
assert.equal(timers.size, 1, "active schedule owns one timer");
await handlers.get("session_shutdown")({}, context);
assert.equal(statuses.has("scheduler"), false);
assert.equal(timers.size, 0, "session shutdown clears active timers");
assert.equal(widgets.has("scheduler"), false);
assert.ok(widgets.has("herdr-subagents"), "Scheduler shutdown does not remove Herdr Fleet");
assert.ok(renderRequests >= 4, "schedule changes request widget rerenders");

await handlers.get("session_start")({}, context);
await command.handler("  检查 CI  并报告结果  ", context);
assert.match(notifications.at(-1).message, /Created schedule-\d+: every 20s/);
assert.equal(notifications.at(-1).level, "info");
let scheduled = (await tool.execute("default-list", { action: "list" })).details.schedules;
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0].intervalMs, 20_000);
assert.equal(scheduled[0].prompt, "检查 CI  并报告结果", "the shortcut preserves the prompt's internal whitespace");
assert.equal([...timers.values()][0].delayMs, 20_000);
const previousMessages = messages.length;
fireNextTimer();
assert.equal(messages.length, previousMessages + 1);
assert.deepEqual(messages.at(-1).options, { triggerTurn: true, deliverAs: "followUp" });
assert.equal(messages.at(-1).message.content, `[Scheduled prompt: ${scheduled[0].id}]\n检查 CI  并报告结果`);
fireNextTimer();
assert.equal(messages.length, previousMessages + 1, "pending schedules coalesce repeated intervals");
await handlers.get("message_start")({ message: asAppMessage(messages.at(-1)) });
await command.handler("cancel", context);
assert.equal(timers.size, 0);

await command.handler("add 5m Check CI", context);
assert.match(notifications.at(-1).message, /every 5m/);
scheduled = (await tool.execute("explicit-list", { action: "list" })).details.schedules;
assert.equal(scheduled[0].intervalMs, 300_000);
await command.handler("add 20s list all checks", context);
assert.match(notifications.at(-1).message, /every 20s/);
await command.handler("add 20s trigger deployment check", context);
assert.match(notifications.at(-1).message, /every 20s/);
scheduled = (await tool.execute("reserved-prompt-list", { action: "list" })).details.schedules;
assert.ok(scheduled.some((item) => item.prompt === "list all checks"));
assert.ok(scheduled.some((item) => item.prompt === "trigger deployment check"));
await command.handler("trigger schedule-1", context);
assert.equal(notifications.at(-1).message, "trigger is no longer supported");
assert.equal(notifications.at(-1).level, "error");
await command.handler("add", context);
assert.equal(notifications.at(-1).level, "error");
await command.handler("list extra", context);
assert.equal(notifications.at(-1).level, "error");
await command.handler("clear", context);
assert.equal(timers.size, 0);
await command.handler("", context);
assert.equal(notifications.at(-1).message, "No active schedules.");
await handlers.get("session_shutdown")({}, context);
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
console.log("Scheduler extension integration tests passed");
