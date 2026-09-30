/**
 * Session-scoped todo extension with branch-aware persistence.
 *
 * Provides the `todo` tool, a compact active-work widget, and `/todos` current-plan view.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	activeTodoRows,
	applyTodoAction,
	countTodoStatuses,
	normalizeTodo,
	restoreTodoState,
	type StoredTodo,
	type Todo,
	type TodoAction,
	type TodoState,
	type TodoStatus,
} from "./todo-state.ts";

interface TodoDetails {
	action: TodoAction;
	todos: StoredTodo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "replace", "add", "update", "remove", "clear"] as const, {
		description: "list current tasks; replace the plan; add one; update status; remove one; or clear all",
	}),
	items: Type.Optional(Type.Array(Type.String(), {
		minItems: 1,
		description: "Complete ordered task texts for replace",
	})),
	text: Type.Optional(Type.String({ description: "Task text for add" })),
	id: Type.Optional(Type.Integer({ minimum: 1, description: "Task ID for update or remove" })),
	status: Type.Optional(StringEnum(["todo", "doing", "done", "cancelled"] as const, {
		description: "New status for update; optional initial status for add",
	})),
});

const WIDGET_KEY = "todo-list";

function sortedTodos(todos: Todo[]): Todo[] {
	return [...todos].sort((a, b) => a.id - b.id);
}

function statusMarker(status: TodoStatus): string {
	if (status === "doing") return "◼";
	if (status === "done") return "✔";
	if (status === "cancelled") return "✖";
	return "◻";
}

function themedStatus(theme: Theme, status: TodoStatus, text: string): string {
	if (status === "doing") return theme.fg("warning", text);
	if (status === "done") return theme.fg("success", text);
	if (status === "cancelled") return theme.fg("error", text);
	return theme.fg("dim", text);
}

function taskSummary(todos: Todo[]): string {
	const counts = countTodoStatuses(todos);
	const active = counts.todo + counts.doing;
	const parts = [`${active} active (${counts.doing} doing, ${counts.todo} queued)`];
	if (counts.done > 0) parts.push(`${counts.done} done`);
	if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
	return parts.join(" · ");
}

function renderTodoLine(theme: Theme, todo: Todo): string {
	const icon = themedStatus(theme, todo.status, statusMarker(todo.status));
	if (todo.status === "done" || todo.status === "cancelled") {
		return `${icon} \x1b[9m${theme.fg("dim", `#${todo.id} ${todo.text}`)}\x1b[29m`;
	}
	return `${icon} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("text", todo.text)}`;
}

function renderActiveTodoLine(theme: Theme, todo: Todo, position: number): string {
	const icon = themedStatus(theme, todo.status, statusMarker(todo.status));
	return `${icon} ${theme.fg("accent", `${position}.`)} ${theme.fg("text", todo.text)}`;
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

	let state: TodoState = { todos: [], nextId: 1 };

	const snapshot = (): StoredTodo[] => state.todos.map((todo) => ({ ...todo }));

	const refreshUI = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const visible = activeTodoRows(state.todos);
		if (visible.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render(width: number): string[] {
					return [
						truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("muted", taskSummary(state.todos))}`, width),
						...visible.map(({ position, todo }) => truncateToWidth(`  ${renderActiveTodoLine(theme, todo, position)}`, width)),
					];
				},
				invalidate() {},
			}),
		);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		state = { todos: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "todo") continue;
			const details = message.details as TodoDetails | undefined;
			if (!details || !Array.isArray(details.todos) || typeof details.nextId !== "number") continue;
			state = restoreTodoState(details.todos, details.nextId);
		}
		refreshUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Track explicit checklists and non-trivial multi-step work. Replace the plan when instructions change. The tool keeps one task doing and advances automatically; mark obsolete work cancelled and verified work done.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTodoAction(state, params);
			state = { todos: result.todos, nextId: result.nextId };
			const text = params.action === "list"
				? state.todos.length
					? sortedTodos(state.todos).map((todo) => `${statusMarker(todo.status)} #${todo.id} [${todo.status}] ${todo.text}`).join("\n")
					: "No todos"
				: result.message;

			refreshUI(ctx);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					action: params.action,
					todos: snapshot(),
					nextId: state.nextId,
					...(result.error ? { error: result.error } : {}),
				} as TodoDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.items) text += ` ${theme.fg("dim", `${args.items.length} tasks`)}`;
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
				return new Text(sortedTodos(list).map((todo) => renderTodoLine(theme, todo)).join("\n"), 0, 0);
			}

			const item = result.content[0];
			const message = item?.type === "text" ? item.text : "";
			return new Text(theme.fg("success", "> ") + theme.fg("muted", message), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show active and closed tasks in the current plan",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
				new TodoListComponent(state.todos, theme, () => done()),
			);
		},
	});
}
