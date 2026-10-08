import assert from "node:assert/strict";
import {
	activeTodoRows,
	activeTodos,
	applyTodoAction,
	formatCurrentPlan,
	restoreTodoState,
} from "../src/todo-state.ts";

const empty = { todos: [], nextId: 1 };

let state = applyTodoAction(empty, {
	action: "plan",
	items: ["Inspect the failure", "Implement the fix", "Run verification"],
});
assert.deepEqual(state.todos, [
	{ id: 1, text: "Inspect the failure", status: "doing" },
	{ id: 2, text: "Implement the fix", status: "todo" },
	{ id: 3, text: "Run verification", status: "todo" },
]);
assert.equal(state.nextId, 4);

state = applyTodoAction(state, { action: "complete_current", expected_current_id: 1 });
assert.deepEqual(state.todos.map(({ id, status }) => ({ id, status })), [
	{ id: 1, status: "done" },
	{ id: 2, status: "doing" },
	{ id: 3, status: "todo" },
]);

const stale = applyTodoAction(state, { action: "complete_current", expected_current_id: 1 });
assert.match(stale.error ?? "", /current is #2/);
assert.deepEqual(stale.todos, state.todos, "repeated or stale completion is atomic");
assert.equal(stale.nextId, state.nextId);

const missingExpectedId = applyTodoAction(state, { action: "cancel_current" });
assert.match(missingExpectedId.error ?? "", /expected_current_id is required/);
assert.deepEqual(missingExpectedId.todos, state.todos);

state = applyTodoAction(state, { action: "cancel_current", expected_current_id: 2 });
assert.deepEqual(state.todos.map(({ id, status }) => ({ id, status })), [
	{ id: 1, status: "done" },
	{ id: 2, status: "cancelled" },
	{ id: 3, status: "doing" },
], "cancelling only the current step keeps the later plan valid and advances once");

state = applyTodoAction(state, { action: "add_step", text: "Review the result" });
assert.deepEqual(activeTodos(state.todos).map(({ id, status }) => ({ id, status })), [
	{ id: 3, status: "doing" },
	{ id: 4, status: "todo" },
], "add_step only appends to the current plan");

state = applyTodoAction(state, { action: "plan", items: ["Investigate new direction", "Verify new direction"] });
assert.deepEqual(state.todos, [
	{ id: 1, text: "Inspect the failure", status: "done" },
	{ id: 2, text: "Implement the fix", status: "cancelled" },
	{ id: 3, text: "Run verification", status: "cancelled" },
	{ id: 4, text: "Review the result", status: "cancelled" },
	{ id: 5, text: "Investigate new direction", status: "doing" },
	{ id: 6, text: "Verify new direction", status: "todo" },
], "replanning preserves closed history and cancels every old unfinished step");
assert.equal(state.nextId, 7, "replanning allocates fresh monotonic IDs");
assert.deepEqual(activeTodoRows(state.todos).map(({ position, todo }) => ({ position, id: todo.id })), [
	{ position: 1, id: 5 },
	{ position: 2, id: 6 },
], "display positions are contiguous and independent of internal IDs");
assert.equal(formatCurrentPlan(state.todos), "CURRENT plan\n#5 [doing] Investigate new direction\n#6 [todo] Verify new direction");

const invalidPlan = applyTodoAction(state, { action: "plan", items: ["valid", " "] });
assert.ok(invalidPlan.error);
assert.deepEqual(invalidPlan.todos, state.todos, "invalid plan text leaves history and current plan unchanged");

const repeatedText = applyTodoAction(state, { action: "add_step", text: "Verify new direction" });
assert.equal(repeatedText.error, undefined, "step text is not interpreted as a marker or uniqueness key");
assert.equal(repeatedText.todos.at(-1)?.text, "Verify new direction");

state = applyTodoAction(state, { action: "plan", items: [] });
assert.equal(activeTodos(state.todos).length, 0, "an empty plan leaves no current plan");
assert.equal(formatCurrentPlan(state.todos), "CURRENT plan: none");
assert.equal(state.nextId, 7, "an empty plan does not reset or consume IDs");
assert.equal(state.todos.find(({ id }) => id === 1)?.status, "done", "empty plan retains closed history");

const appendedAfterEmpty = applyTodoAction(state, { action: "add_step", text: "A later explicit step" });
assert.deepEqual(appendedAfterEmpty.todos.at(-1), { id: 7, text: "A later explicit step", status: "doing" });

const restored = restoreTodoState([
	{ id: 4, text: "legacy complete", done: true },
	{ id: 2, text: "first active", status: "doing" },
	{ id: 3, text: "second active", status: "doing" },
], 2);
assert.deepEqual(restored.todos.map(({ id, status }) => ({ id, status })), [
	{ id: 2, status: "doing" },
	{ id: 3, status: "todo" },
	{ id: 4, status: "done" },
]);
assert.equal(restored.nextId, 5, "branch restoration repairs stale ID counters");

const legacyReordered = restoreTodoState([
	{ id: 1, text: "demoted by legacy update", status: "todo" },
	{ id: 2, text: "legacy current", status: "doing" },
	{ id: 3, text: "legacy queued", status: "todo" },
]);
assert.deepEqual(activeTodos(legacyReordered.todos).map(({ id, status }) => ({ id, status })), [
	{ id: 2, status: "doing" },
	{ id: 1, status: "todo" },
	{ id: 3, status: "todo" },
], "legacy snapshots project the sole doing step before every queued step");

console.log("Todo state tests passed");
