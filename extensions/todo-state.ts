export type TodoStatus = "todo" | "doing" | "done" | "cancelled";
export type TodoAction = "list" | "replace" | "add" | "update" | "remove" | "clear";

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
	text?: string;
	items?: string[];
	id?: number;
	status?: TodoStatus;
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
	return todos.filter((todo) => todo.status === "doing" || todo.status === "todo");
}

export function activeTodoRows(todos: Todo[]): ActiveTodoRow[] {
	return activeTodos(todos).map((todo, index) => ({ position: index + 1, todo }));
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

function hasActiveDuplicate(todos: Todo[], text: string): boolean {
	return todos.some((todo) => (todo.status === "todo" || todo.status === "doing") && todo.text === text);
}

export function applyTodoAction(state: TodoState, input: TodoActionInput): TodoActionResult {
	const next = cloneState(state);

	switch (input.action) {
		case "list":
			return { ...next, message: next.todos.length ? "Listed todos" : "No todos" };

		case "replace": {
			if (!input.items?.length) return fail(state, "items required for replace");
			const items = input.items.map(cleanText);
			if (items.some((item) => item === undefined)) return fail(state, "replace items must not be empty");
			const texts = items as string[];
			if (new Set(texts).size !== texts.length) return fail(state, "replace items must be unique");
			const firstId = next.nextId;
			next.todos = texts.map((text, index) => ({ id: firstId + index, text, status: index === 0 ? "doing" : "todo" }));
			next.nextId += next.todos.length;
			return { ...next, message: `Replaced plan with ${next.todos.length} tasks` };
		}

		case "add": {
			const text = cleanText(input.text);
			if (!text) return fail(state, "text required for add");
			if (hasActiveDuplicate(next.todos, text)) return fail(state, `active task already exists: ${text}`);
			if (input.status === "doing") {
				for (const todo of next.todos) if (todo.status === "doing") todo.status = "todo";
			}
			const todo: Todo = { id: next.nextId++, text, status: input.status ?? "todo" };
			next.todos.push(todo);
			normalizeTodoFlow(next.todos);
			return { ...next, message: `Added todo #${todo.id} [${todo.status}]: ${todo.text}` };
		}

		case "update": {
			if (input.id === undefined || input.status === undefined) return fail(state, "id and status required for update");
			const todo = next.todos.find((item) => item.id === input.id);
			if (!todo) return fail(state, `#${input.id} not found`);
			if (input.status === "doing") {
				for (const item of next.todos) if (item.status === "doing") item.status = "todo";
			}
			todo.status = input.status;
			normalizeTodoFlow(next.todos);
			return { ...next, message: `Todo #${todo.id} is now ${todo.status}` };
		}

		case "remove": {
			if (input.id === undefined) return fail(state, "id required for remove");
			const index = next.todos.findIndex((item) => item.id === input.id);
			if (index < 0) return fail(state, `#${input.id} not found`);
			const [removed] = next.todos.splice(index, 1);
			normalizeTodoFlow(next.todos);
			return { ...next, message: `Removed todo #${removed.id}: ${removed.text}` };
		}

		case "clear": {
			const count = next.todos.length;
			return { todos: [], nextId: 1, message: `Cleared ${count} todos` };
		}
	}
}
