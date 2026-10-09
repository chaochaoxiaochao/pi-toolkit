import assert from "node:assert/strict";
import registerScheduler from "../extensions/scheduler.ts";

const handlers = new Map();
const commands = new Map();
const messages = [];
const statuses = new Map();
let tool;
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
	ui: {
		setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
		notify(message, level) { notifications.push({ message, level }); },
	},
};
await handlers.get("session_start")({}, context);
assert.ok(tool);
assert.ok(commands.has("schedule"));

const add = await tool.execute("add", { action: "add", every: "1h", prompt: "Check CI" });
assert.match(add.content[0].text, /Created schedule-1/);
assert.match(statuses.get("scheduler"), /1 schedule/);

const trigger = await tool.execute("trigger", { action: "trigger", id: "schedule-1" });
assert.match(trigger.content[0].text, /Triggered schedule-1/);
assert.equal(messages.length, 1);
assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
assert.match(messages[0].message.content, /\[Scheduled prompt: schedule-1; source=manual\]\nCheck CI/);
const duplicate = await tool.execute("trigger-again", { action: "trigger", id: "schedule-1" });
assert.equal(duplicate.isError, true);

await handlers.get("message_start")({ message: { role: "custom", customType: "other", details: { scheduleId: "schedule-1" } } });
assert.equal((await tool.execute("still-pending", { action: "trigger", id: "schedule-1" })).isError, true, "unrelated custom messages do not acknowledge a schedule");
await handlers.get("message_start")({ message: asAppMessage(messages[0]) });
await commands.get("schedule").handler("trigger schedule-1", context);
assert.equal(messages.length, 2);
assert.match(notifications.at(-1).message, /regular next time is unchanged/);
await commands.get("schedule").handler("list", context);
assert.match(notifications.at(-1).message, /schedule-1/);

await handlers.get("agent_settled")({ aborted: false });
await commands.get("schedule").handler("trigger schedule-1", context);
assert.equal(messages.length, 3, "settlement releases a queued scheduler message that never reached message_start");
await handlers.get("message_start")({ message: asAppMessage(messages[2]) });
await commands.get("schedule").handler("cancel schedule-1", context);
assert.match(notifications.at(-1).message, /Already queued prompts cannot be withdrawn/);
assert.equal(statuses.has("scheduler"), false);
await tool.execute("shutdown-add", { action: "add", every: "2h", prompt: "Check deployment" });
assert.equal(timers.size, 1, "active schedule owns one timer");
await handlers.get("session_shutdown")({}, context);
assert.equal(statuses.has("scheduler"), false);
assert.equal(timers.size, 0, "session shutdown clears active timers");
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
console.log("Scheduler extension integration tests passed");
