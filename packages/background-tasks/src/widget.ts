import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Clock, TaskSnapshot } from "./background-tasks.ts";

export const WIDGET_KEY = "background-tasks";
export const FINISHED_VISIBLE_MS = 5000;

export function visibleTasks(tasks: TaskSnapshot[], now: number): TaskSnapshot[] {
	return tasks.filter((task) => task.status === "running" || (task.ended_at !== undefined && now < task.ended_at + FINISHED_VISIBLE_MS));
}

export function duration(seconds: number): string {
	const value = Math.max(0, Math.floor(seconds));
	if (value >= 3600) return `${Math.floor(value / 3600)}h${value % 3600 ? ` ${Math.floor(value % 3600 / 60)}m` : ""}`;
	if (value >= 60) return `${Math.floor(value / 60)}m${value % 60 ? ` ${value % 60}s` : ""}`;
	return `${value}s`;
}

/** Compact, clickable shell count below the editor. The native footer stays intact. */
export class BackgroundWidget {
	private hitWidth = 0;
	private readonly getTasks: () => TaskSnapshot[];
	private readonly clock: Clock;
	private readonly theme: Theme;
	private readonly onSelect: () => void;
	constructor(getTasks: () => TaskSnapshot[], clock: Clock, theme: Theme, onSelect: () => void) {
		this.getTasks = getTasks;
		this.clock = clock;
		this.theme = theme;
		this.onSelect = onSelect;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0 || event.x < 0 || event.x >= this.hitWidth) return;
		this.onSelect();
		return { handled: true, render: false };
	}

	render(width: number): string[] {
		const tasks = visibleTasks(this.getTasks(), this.clock.now());
		const active = tasks.filter((task) => task.status === "running").length;
		const ended = tasks.length - active;
		const label = `${active} ${active === 1 ? "shell" : "shells"}${ended ? ` · ${ended} done` : ""}`;
		const text = truncateToWidth(this.theme.fg("accent", label), width);
		this.hitWidth = tasks.length ? visibleWidth(text) : 0;
		return [truncateToWidth(`${text}${this.theme.fg("dim", " · Alt+J")}`, width)];
	}

	invalidate(): void { this.hitWidth = 0; }
}
