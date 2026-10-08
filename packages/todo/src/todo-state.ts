export type TodoStatus = "todo" | "doing" | "done" | "cancelled";
export type TodoAction = "plan" | "add_step" | "complete_current" | "cancel_current" | "list";

export interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface StoredTodo {
	id: number;
	text: string;
	status?: TodoStatus;
	done?: boolean;
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

export interface ActiveTodoRow {
	position: number;
	todo: Todo;
}

export interface TodoActionInput {
	action: TodoAction;
	items?: string[];
	text?: string;
	expected_current_id?: number;
}

export interface TodoActionResult extends TodoState {
	message: string;
	error?: string;
}

export type TodoCounts = Record<TodoStatus, number>;

export function normalizeTodo(todo: StoredTodo): Todo {
	const status = todo.status === "todo" || todo.status === "doing" || todo.status === "done" || todo.status === "cancelled"
		? todo.status
		: todo.done
			? "done"
			: "todo";
	return { id: todo.id, text: todo.text, status };
}

export function normalizeTodoFlow(todos: Todo[]): void {
	const active = todos.filter((todo) => todo.status === "doing");
	for (const todo of active.slice(1)) todo.status = "todo";
	if (active.length > 0) return;

	const next = todos.find((todo) => todo.status === "todo");
	if (next) next.status = "doing";
}

export function restoreTodoState(stored: StoredTodo[], nextId?: number): TodoState {
	const todos = stored.map(normalizeTodo).sort((a, b) => a.id - b.id);
	normalizeTodoFlow(todos);
	const minimumNextId = todos.reduce((max, todo) => Math.max(max, todo.id + 1), 1);
	return { todos, nextId: Math.max(nextId ?? 1, minimumNextId) };
}

export function countTodoStatuses(todos: Todo[]): TodoCounts {
	return todos.reduce<TodoCounts>(
		(counts, todo) => {
			counts[todo.status] += 1;
			return counts;
		},
		{ todo: 0, doing: 0, done: 0, cancelled: 0 },
	);
}

export function activeTodos(todos: Todo[]): Todo[] {
	return [
		...todos.filter((todo) => todo.status === "doing"),
		...todos.filter((todo) => todo.status === "todo"),
	];
}

export function activeTodoRows(todos: Todo[]): ActiveTodoRow[] {
	return activeTodos(todos).map((todo, index) => ({ position: index + 1, todo }));
}

export function currentTodo(todos: Todo[]): Todo | undefined {
	return todos.find((todo) => todo.status === "doing");
}

export function formatCurrentPlan(todos: Todo[]): string {
	const current = activeTodos(todos);
	if (current.length === 0) return "CURRENT plan: none";
	return ["CURRENT plan", ...current.map((todo) => `#${todo.id} [${todo.status}] ${todo.text}`)].join("\n");
}

function cloneState(state: TodoState): TodoState {
	return { todos: state.todos.map((todo) => ({ ...todo })), nextId: state.nextId };
}

function fail(state: TodoState, error: string): TodoActionResult {
	return { ...cloneState(state), message: `Error: ${error}`, error };
}

function cleanText(text: string | undefined): string | undefined {
	const cleaned = text?.trim();
	return cleaned ? cleaned : undefined;
}

function closeCurrentAndAdvance(next: TodoState, expectedId: number | undefined, status: "done" | "cancelled"): TodoActionResult {
	const current = next.todos.filter((todo) => todo.status === "doing");
	if (expectedId === undefined) return fail(next, "expected_current_id is required");
	if (current.length !== 1 || current[0].id !== expectedId) {
		const actual = current.length === 1 ? `#${current[0].id}` : "none";
		return fail(next, `expected current #${expectedId}, but current is ${actual}`);
	}

	current[0].status = status;
	const following = next.todos.find((todo) => todo.status === "todo");
	if (following) following.status = "doing";
	return { ...next, message: `${status === "done" ? "Completed" : "Cancelled"} current step #${expectedId}` };
}

export function applyTodoAction(state: TodoState, input: TodoActionInput): TodoActionResult {
	const next = cloneState(state);

	switch (input.action) {
		case "list":
			return { ...next, message: "Listed current plan" };

		case "plan": {
			if (!input.items) return fail(state, "items is required for plan");
			const items = input.items.map(cleanText);
			if (items.some((item) => item === undefined)) return fail(state, "plan items must not be empty");
			for (const todo of next.todos) {
				if (todo.status === "doing" || todo.status === "todo") todo.status = "cancelled";
			}
			const texts = items as string[];
			for (const [index, text] of texts.entries()) {
				next.todos.push({ id: next.nextId++, text, status: index === 0 ? "doing" : "todo" });
			}
			return { ...next, message: texts.length === 0 ? "Cancelled all unfinished work" : `Planned ${texts.length} steps` };
		}

		case "add_step": {
			const text = cleanText(input.text);
			if (!text) return fail(state, "text is required for add_step");
			const todo: Todo = { id: next.nextId++, text, status: currentTodo(next.todos) ? "todo" : "doing" };
			next.todos.push(todo);
			return { ...next, message: `Added step #${todo.id}` };
		}

		case "complete_current":
			return closeCurrentAndAdvance(next, input.expected_current_id, "done");

		case "cancel_current":
			return closeCurrentAndAdvance(next, input.expected_current_id, "cancelled");
	}
}
