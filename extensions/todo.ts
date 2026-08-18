/**
 * Lightweight todo extension with branch-aware session persistence.
 *
 * Provides one `todo` tool, a `/todos` dialog, a persistent below-editor
 * widget, and footer counts. It has no subagent integration or prompt hooks.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "todo" | "doing" | "done";
type TodoAction = "list" | "add" | "update" | "toggle" | "clear";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface StoredTodo {
	id: number;
	text: string;
	status?: TodoStatus;
	done?: boolean;
}

interface TodoDetails {
	action: TodoAction;
	todos: StoredTodo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "toggle", "clear"] as const, {
		description: "Operation to perform. Prefer update over toggle when setting an explicit status.",
	}),
	text: Type.Optional(Type.String({ description: "Specific, outcome-oriented task text. Required for add." })),
	id: Type.Optional(Type.Number({ description: "Todo ID. Required for update and toggle." })),
	status: Type.Optional(StringEnum(["todo", "doing", "done"] as const, {
		description: "Explicit task state. Required for update; optional for add (defaults to todo).",
	})),
});

const WIDGET_KEY = "todo-list";

function normalizeTodo(todo: StoredTodo): Todo {
	const status = todo.status === "todo" || todo.status === "doing" || todo.status === "done"
		? todo.status
		: todo.done
			? "done"
			: "todo";
	return { id: todo.id, text: todo.text, status };
}

function countStatuses(todos: Todo[]): Record<TodoStatus, number> {
	return todos.reduce<Record<TodoStatus, number>>(
		(counts, todo) => {
			counts[todo.status] += 1;
			return counts;
		},
		{ todo: 0, doing: 0, done: 0 },
	);
}

function sortedTodos(todos: Todo[]): Todo[] {
	return [...todos].sort((a, b) => a.id - b.id);
}

function statusMarker(status: TodoStatus): string {
	if (status === "doing") return "◼";
	if (status === "done") return "✔";
	return "◻";
}

function themedStatus(theme: Theme, status: TodoStatus, text: string): string {
	if (status === "doing") return theme.fg("warning", text);
	if (status === "done") return theme.fg("success", text);
	return theme.fg("dim", text);
}

function taskSummary(todos: Todo[]): string {
	const counts = countStatuses(todos);
	const noun = todos.length === 1 ? "task" : "tasks";
	return `${todos.length} ${noun} (${counts.done} done, ${counts.doing} in progress, ${counts.todo} open)`;
}

function renderTodoLine(theme: Theme, todo: Todo): string {
	const icon = themedStatus(theme, todo.status, statusMarker(todo.status));
	if (todo.status === "done") {
		return `${icon} \x1b[9m${theme.fg("dim", `#${todo.id} ${todo.text}`)}\x1b[29m`;
	}
	return `${icon} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("text", todo.text)}`;
}

class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly todos: Todo[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const border = this.theme.fg("borderMuted", "-".repeat(Math.max(0, width - 10)));
		const lines = ["", truncateToWidth(`${this.theme.fg("borderMuted", "---")}${this.theme.fg("accent", " Todos ")}${border}`, width), ""];

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No todos")}`, width));
		} else {
			lines.push(truncateToWidth(
				`${this.theme.fg("accent", "●")} ${this.theme.fg("muted", taskSummary(this.todos))}`,
				width,
			));
			lines.push("");
			for (const todo of sortedTodos(this.todos)) {
				lines.push(truncateToWidth(`  ${renderTodoLine(this.theme, todo)}`, width));
			}
		}

		lines.push("", truncateToWidth(`  ${this.theme.fg("dim", "Press Escape to close")}`, width), "");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let todos: Todo[] = [];
	let nextId = 1;

	const snapshot = (): StoredTodo[] => todos.map((todo) => ({ ...todo }));

	const refreshUI = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render(width: number): string[] {
					return [
						truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("muted", taskSummary(todos))}`, width),
						...sortedTodos(todos).map((todo) => truncateToWidth(`  ${renderTodoLine(theme, todo)}`, width)),
					];
				},
				invalidate() {},
			}),
		);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "todo") continue;
			const details = message.details as TodoDetails | undefined;
			if (!details || !Array.isArray(details.todos) || typeof details.nextId !== "number") continue;
			todos = details.todos.map(normalizeTodo);
			nextId = details.nextId;
		}
		refreshUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: `Maintain a visible, session-scoped task list with explicit todo, doing, and done states.

Use this tool when:
- The user asks for a checklist, plan, or progress tracking.
- Work has multiple concrete steps whose progress should remain visible.
- A task starts, finishes, becomes pending again, or the current state must be inspected.

Do not create a list for a single trivial action unless the user explicitly requests one. Keep task text specific and outcome-oriented. Avoid duplicate tasks.

States:
- todo: Planned but not started, or intentionally returned to the queue.
- doing: Actively being worked on now. Set this immediately before starting the task.
- done: Fully completed and, when applicable, verified. Never mark partial or failed work done.

Actions:
- list: Read the complete current list. Use before updating when IDs or current states are uncertain, and when reporting progress.
- add: Create one task using text. It defaults to todo; pass status only when the task is already active or completed.
- update: Set an exact state using id and status. This is the preferred way to move tasks between todo, doing, and done.
- toggle: Cycle one task todo -> doing -> done -> todo. Use only for quick manual-style transitions when the current state is already known; otherwise use update.
- clear: Remove the entire list and reset IDs. Use only when the user requests a reset or the whole list is obsolete.

Execution discipline:
- Move a task to doing before performing it.
- Move it to done immediately after successful completion and verification.
- Leave failed, blocked, or incomplete work as doing, or move it back to todo when it is no longer active.
- Keep only genuinely active work in doing; sequential workflows normally have one doing task at a time.`,
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let text: string;
			let error: string | undefined;

			switch (params.action) {
				case "list":
					text = todos.length
						? sortedTodos(todos).map((todo) => `${statusMarker(todo.status)} #${todo.id} [${todo.status}] ${todo.text}`).join("\n")
						: "No todos";
					break;

				case "add": {
					if (!params.text) {
						error = "text required for add";
						text = `Error: ${error}`;
						break;
					}
					const todo: Todo = { id: nextId++, text: params.text, status: params.status ?? "todo" };
					todos.push(todo);
					text = `Added todo #${todo.id} [${todo.status}]: ${todo.text}`;
					break;
				}

				case "update": {
					if (params.id === undefined || params.status === undefined) {
						error = "id and status required for update";
						text = `Error: ${error}`;
						break;
					}
					const todo = todos.find((item) => item.id === params.id);
					if (!todo) {
						error = `#${params.id} not found`;
						text = `Todo ${error}`;
						break;
					}
					todo.status = params.status;
					text = `Todo #${todo.id} is now ${todo.status}`;
					break;
				}

				case "toggle": {
					if (params.id === undefined) {
						error = "id required for toggle";
						text = `Error: ${error}`;
						break;
					}
					const todo = todos.find((item) => item.id === params.id);
					if (!todo) {
						error = `#${params.id} not found`;
						text = `Todo ${error}`;
						break;
					}
					todo.status = todo.status === "todo" ? "doing" : todo.status === "doing" ? "done" : "todo";
					text = `Todo #${todo.id} is now ${todo.status}`;
					break;
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					text = `Cleared ${count} todos`;
					break;
				}
			}

			refreshUI(ctx);
			return {
				content: [{ type: "text" as const, text }],
				details: { action: params.action, todos: snapshot(), nextId, ...(error ? { error } : {}) } as TodoDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${themedStatus(theme, args.status, args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const item = result.content[0];
				return new Text(item?.type === "text" ? item.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			if (details.action === "list") {
				const list = details.todos.map(normalizeTodo);
				if (list.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
				const display = sortedTodos(list);
				const output = display.map((todo) => renderTodoLine(theme, todo)).join("\n");
				return new Text(output, 0, 0);
			}

			const item = result.content[0];
			const message = item?.type === "text" ? item.text : "";
			return new Text(theme.fg("success", "> ") + theme.fg("muted", message), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
				new TodoListComponent(todos, theme, () => done()),
			);
		},
	});
}
