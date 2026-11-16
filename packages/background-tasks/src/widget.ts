import { FooterComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
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

/** Locate the exported native component through the public TUI container tree. */
export function findNativeFooter(children: Component[]): FooterComponent | undefined {
	for (const child of children) {
		if (child instanceof FooterComponent) return child;
		if ("children" in child && Array.isArray(child.children)) {
			const footer = findNativeFooter(child.children);
			if (footer) return footer;
		}
	}
}

/** Keep native usage/model rendering; add a clickable count to its final status row. */
export class BackgroundFooter {
	private hit?: { x: number; y: number; width: number };
	private readonly native: Component;
	private readonly getTasks: () => TaskSnapshot[];
	private readonly clock: Clock;
	private readonly theme: Theme;
	private readonly hasStatuses: () => boolean;
	private readonly panelOpen: () => boolean;
	private readonly onSelect: () => void;
	constructor(native: Component, getTasks: () => TaskSnapshot[], clock: Clock, theme: Theme, hasStatuses: () => boolean, panelOpen: () => boolean, onSelect: () => void) {
		this.native = native;
		this.getTasks = getTasks;
		this.clock = clock;
		this.theme = theme;
		this.hasStatuses = hasStatuses;
		this.panelOpen = panelOpen;
		this.onSelect = onSelect;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hit = this.hit;
		if (this.panelOpen() || !hit || event.type !== "click" || event.button !== "left" || event.y !== hit.y || event.x < hit.x || event.x >= hit.x + hit.width) return;
		this.onSelect();
		return { handled: true, render: false };
	}

	render(width: number): string[] {
		this.hit = undefined;
		if (this.panelOpen()) return [];
		const lines = this.native.render(width);
		const tasks = visibleTasks(this.getTasks(), this.clock.now());
		if (!tasks.length) return lines;
		const active = tasks.filter((task) => task.status === "running").length;
		const ended = tasks.length - active;
		const label = `${active} ${active === 1 ? "shell" : "shells"}${ended ? ` · ${ended} done` : ""}`;
		const hint = width >= visibleWidth(label) + 8 ? this.theme.fg("dim", " · Alt+J") : "";
		const text = truncateToWidth(this.theme.fg("accent", label) + hint, width, "");
		const status = this.hasStatuses() ? lines.pop()! : "";
		const available = width - visibleWidth(text) - 3;
		const prefix = status && available > 0 ? truncateToWidth(status, available, "…") + " · " : "";
		this.hit = { x: visibleWidth(prefix), y: lines.length, width: Math.min(visibleWidth(label), visibleWidth(text)) };
		return [...lines, prefix + text];
	}

	invalidate(): void { this.hit = undefined; this.native.invalidate(); }
}
