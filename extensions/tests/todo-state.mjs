import assert from "node:assert/strict";
import {
	activeTodoRows,
	activeTodos,
	applyTodoAction,
	restoreTodoState,
} from "../todo-state.ts";

const empty = { todos: [], nextId: 1 };

assert.deepEqual(
	activeTodoRows([
		{ id: 8, text: "closed", status: "done" },
		{ id: 9, text: "current", status: "doing" },
		{ id: 11, text: "next", status: "todo" },
	]).map(({ position, todo }) => ({ position, id: todo.id })),
	[
		{ position: 1, id: 9 },
		{ position: 2, id: 11 },
	],
	"active rows expose contiguous queue positions independently of internal IDs",
);

const replaced = applyTodoAction(empty, {
	action: "replace",
	items: ["Inspect the failure", "Implement the fix", "Run verification"],
});
assert.deepEqual(
	replaced.todos.map(({ id, text, status }) => ({ id, text, status })),
	[
		{ id: 1, text: "Inspect the failure", status: "doing" },
		{ id: 2, text: "Implement the fix", status: "todo" },
		{ id: 3, text: "Run verification", status: "todo" },
	],
	"replace installs a fresh ordered plan and starts its first task",
);
assert.equal(replaced.nextId, 4, "replace advances the ID sequence past the new plan");

const completed = applyTodoAction(replaced, { action: "update", id: 1, status: "done" });
assert.deepEqual(
	completed.todos.map(({ id, status }) => ({ id, status })),
	[
		{ id: 1, status: "done" },
		{ id: 2, status: "doing" },
		{ id: 3, status: "todo" },
	],
	"finishing active work advances the next queued task",
);

const cancelled = applyTodoAction(completed, { action: "update", id: 2, status: "cancelled" });
assert.equal(cancelled.todos[2].status, "doing", "cancelling active work advances the next queued task");
assert.deepEqual(activeTodos(cancelled.todos).map((todo) => todo.id), [3], "closed work is absent from the active view");

const restarted = applyTodoAction(cancelled, { action: "add", text: "Review the redirected implementation", status: "doing" });
assert.equal(restarted.todos.find((todo) => todo.id === 3).status, "todo", "starting another task demotes the previous active task");
assert.equal(restarted.todos.find((todo) => todo.id === 4).status, "doing", "the requested task becomes active");

const removed = applyTodoAction(restarted, { action: "remove", id: 4 });
assert.equal(removed.todos.find((todo) => todo.id === 3).status, "doing", "removing active work advances the queue");
assert.equal(removed.nextId, 5, "removing a task does not reuse its ID");

const duplicate = applyTodoAction(removed, { action: "add", text: "Run verification" });
assert.match(duplicate.error ?? "", /already exists/, "active duplicates are rejected");
assert.deepEqual(duplicate.todos, removed.todos, "a rejected mutation preserves the previous state");

const replacedAgain = applyTodoAction(removed, { action: "replace", items: ["New direction"] });
assert.deepEqual(
	replacedAgain.todos,
	[{ id: 5, text: "New direction", status: "doing" }],
	"replace discards the obsolete plan without reusing an old task ID",
);
assert.equal(replacedAgain.nextId, 6);

const invalidReplace = applyTodoAction(replacedAgain, { action: "replace", items: [" "] });
assert.ok(invalidReplace.error, "replace rejects empty task text");
assert.deepEqual(invalidReplace.todos, replacedAgain.todos, "invalid replacement is atomic");

const restored = restoreTodoState([
	{ id: 4, text: "legacy complete", done: true },
	{ id: 2, text: "first active", status: "doing" },
	{ id: 3, text: "second active", status: "doing" },
], 2);
assert.deepEqual(
	restored.todos.map(({ id, status }) => ({ id, status })),
	[
		{ id: 2, status: "doing" },
		{ id: 3, status: "todo" },
		{ id: 4, status: "done" },
	],
	"restoration migrates legacy entries and enforces one active task",
);
assert.equal(restored.nextId, 5, "restoration repairs stale next IDs");

const cleared = applyTodoAction(restored, { action: "clear" });
assert.deepEqual(cleared.todos, []);
assert.equal(cleared.nextId, 1, "clear resets the ID sequence");

console.log("Todo state tests passed");
