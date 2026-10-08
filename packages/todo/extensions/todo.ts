/**
 * Branch-local execution-plan extension with tool-result snapshot persistence.
 *
 * The model sees only the current plan. The widget mirrors that plan, while
 * `/todos` shows the complete history for the active conversation branch.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	activeTodoRows,
	applyTodoAction,
	countTodoStatuses,
	formatCurrentPlan,
	normalizeTodo,
	restoreTodoState,
	type StoredTodo,
	type Todo,
	type TodoAction,
	type TodoActionInput,
	type TodoState,
	type TodoStatus,
} from "../src/todo-state.ts";

interface TodoDetails {
	action: TodoAction;
	todos: StoredTodo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["plan", "add_step", "complete_current", "cancel_current", "list"] as const, {
		description: "plan creates or replaces the current plan; add_step appends; complete_current or cancel_current advances one expected current step; list reads the current plan",
	}),
	items: Type.Optional(Type.Array(Type.String(), {
		description: "Ordered executable steps for plan; an empty array cancels all unfinished work",
	})),
	text: Type.Optional(Type.String({ description: "Step text for add_step" })),
	expected_current_id: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Stable ID of the sole current doing step; required by complete_current and cancel_current",
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

function historySummary(todos: Todo[]): string {
	const counts = countTodoStatuses(todos);
	return `${todos.length} steps · ${counts.done} done · ${counts.cancelled} cancelled · ${counts.doing + counts.todo} current`;
}

function currentSummary(todos: Todo[]): string {
	const rows = activeTodoRows(todos);
	return `${rows.length} current step${rows.length === 1 ? "" : "s"}`;
}

function renderHistoryLine(theme: Theme, todo: Todo): string {
	const icon = themedStatus(theme, todo.status, statusMarker(todo.status));
	if (todo.status === "done" || todo.status === "cancelled") {
		return `${icon} \x1b[9m${theme.fg("dim", `#${todo.id} ${todo.text}`)}\x1b[29m`;
	}
	return `${icon} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("text", todo.text)}`;
}

function renderCurrentLine(theme: Theme, todo: Todo, position: number): string {
	const icon = themedStatus(theme, todo.status, statusMarker(todo.status));
	return `${icon} ${theme.fg("accent", `${position}.`)} ${theme.fg("text", todo.text)}`;
}

export class CurrentPlanWidget {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly getTodos: () => Todo[];
	private readonly theme: Theme;

	constructor(getTodos: () => Todo[], theme: Theme) {
		this.getTodos = getTodos;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const todos = this.getTodos();
		const rows = activeTodoRows(todos);
		this.cachedLines = [
			truncateToWidth(`${this.theme.fg("accent", "●")} ${this.theme.fg("muted", currentSummary(todos))}`, width),
			...rows.map(({ position, todo }) => truncateToWidth(`  ${renderCurrentLine(this.theme, todo, position)}`, width)),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly todos: Todo[];
	private readonly theme: Theme;
	private readonly onClose: () => void;

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const border = this.theme.fg("borderMuted", "-".repeat(Math.max(0, width - 10)));
		const lines = ["", truncateToWidth(`${this.theme.fg("borderMuted", "---")}${this.theme.fg("accent", " Todos ")}${border}`, width), ""];
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No todo history on this branch")}`, width));
		} else {
			lines.push(truncateToWidth(`${this.theme.fg("accent", "●")} ${this.theme.fg("muted", historySummary(this.todos))}`, width), "");
			for (const todo of sortedTodos(this.todos)) lines.push(truncateToWidth(`  ${renderHistoryLine(this.theme, todo)}`, width));
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

interface MountedWidget {
	component: CurrentPlanWidget;
	tui: { requestRender(): void };
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_HERDR_SUBAGENTS_CHILD === "1") return;

	let state: TodoState = { todos: [], nextId: 1 };
	let mountedWidget: MountedWidget | undefined;
	let actionQueue = Promise.resolve();
	const snapshot = (): StoredTodo[] => state.todos.map((todo) => ({ ...todo }));

	const refreshUI = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const hasCurrentPlan = activeTodoRows(state.todos).length > 0;
		if (!hasCurrentPlan) {
			if (mountedWidget) {
				mountedWidget.component.invalidate();
				ctx.ui.setWidget(WIDGET_KEY, undefined);
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

		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const component = new CurrentPlanWidget(() => state.todos, theme);
			mountedWidget = { component, tui };
			component.invalidate();
			tui.requestRender();
			return component;
		});
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
		mountedWidget = undefined;
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Maintain a branch-local, user-visible CURRENT execution plan. Use plan only for explicit multi-step work, genuinely multi-stage work, or cross-model handoff—not simple one-step tasks. Preserve user intent and order. Complete only work actually done; blocked-but-needed work stays current. cancel_current means the current step is no longer needed while later steps remain valid; changed direction uses plan. Each completion/cancellation must name expected_current_id and advances exactly one step.",
		parameters: TodoParams,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = actionQueue.then(() => {
				const result = applyTodoAction(state, params as TodoActionInput);
				state = { todos: result.todos, nextId: result.nextId };
				refreshUI(ctx);
				return {
					content: [{
						type: "text" as const,
						text: result.error ? `Error: ${result.error}\n\n${formatCurrentPlan(state.todos)}` : formatCurrentPlan(state.todos),
					}],
					details: {
						action: params.action,
						todos: snapshot(),
						nextId: state.nextId,
						...(result.error ? { error: result.error } : {}),
					} as TodoDetails,
					...(result.error ? { isError: true } : {}),
				};
			});
			actionQueue = run.then(() => undefined, () => undefined);
			return run;
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.items) text += ` ${theme.fg("dim", `${args.items.length} steps`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.expected_current_id !== undefined) text += ` ${theme.fg("accent", `#${args.expected_current_id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const item = result.content[0];
			const text = item?.type === "text" ? item.text : "";
			const details = result.details as TodoDetails | undefined;
			return new Text(details?.error ? theme.fg("error", text) : theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show full Todo history on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
				new TodoListComponent(snapshot().map(normalizeTodo), theme, () => done()),
			);
		},
	});
}
