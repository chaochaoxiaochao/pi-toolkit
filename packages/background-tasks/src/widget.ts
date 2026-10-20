import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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

export class BackgroundWidget {
	private lines?: string[];
	private width?: number;
	private readonly getTasks: () => TaskSnapshot[];
	private readonly clock: Clock;
	private readonly theme: Theme;

	constructor(getTasks: () => TaskSnapshot[], clock: Clock, theme: Theme) {
		this.getTasks = getTasks;
		this.clock = clock;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.lines && this.width === width) return this.lines;
		const tasks = visibleTasks(this.getTasks(), this.clock.now());
		const active = tasks.filter((task) => task.status === "running").length;
		const { theme } = this;
		this.lines = [
			truncateToWidth(theme.fg("accent", `Background tasks ${active}/2`), width),
			...tasks.map((task) => {
				const color = task.status === "running" ? "accent" : task.status === "succeeded" ? "success" : task.status === "cancelled" ? "muted" : "error";
				const marker = task.status === "running" ? "●" : task.status === "succeeded" ? "✓" : task.status === "cancelled" ? "○" : "✗";
				const elapsed = ((task.ended_at ?? this.clock.now()) - task.started_at) / 1000;
				return truncateToWidth(`  ${theme.fg(color, marker)} ${theme.fg("accent", task.id)} · ${duration(elapsed)} / ${duration(task.timeout)} · ${theme.fg(color, task.status)} · ${theme.fg("text", task.description)}`, width);
			}),
		];
		this.width = width;
		return this.lines;
	}

	invalidate(): void {
		this.lines = undefined;
		this.width = undefined;
	}
}
