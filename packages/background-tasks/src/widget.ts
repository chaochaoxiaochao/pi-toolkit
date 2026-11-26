import { FooterComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { TaskSnapshot } from "./background-tasks.ts";

export const WIDGET_KEY = "background-tasks";
export const FINISHED_VISIBLE_MS = 5000;

export function visibleTasks(tasks: TaskSnapshot[], now: number): TaskSnapshot[] {
	return tasks.filter((task) => task.status === "running" || (task.ended_at !== undefined && now < task.ended_at + FINISHED_VISIBLE_MS));
}

export function taskStatusLabel(tasks: TaskSnapshot[]): string | undefined {
	if (!tasks.length) return undefined;
	const active = tasks.filter((task) => task.status === "running").length;
	const ended = tasks.length - active;
	return `${active} ${active === 1 ? "shell" : "shells"}${ended ? ` · ${ended} done` : ""}`;
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

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Keep native usage/model rendering; add a clickable count to its final status row. */
export class BackgroundFooter {
	private hit?: { x: number; y: number; width: number };
	private readonly native: Component;
	private readonly theme: Theme;
	private readonly getStatuses: () => ReadonlyMap<string, string>;
	private readonly panelOpen: () => boolean;
	private readonly onSelect: () => void;
	private readonly onDispose: () => void;
	private disposed = false;
	constructor(native: Component, theme: Theme, getStatuses: () => ReadonlyMap<string, string>, panelOpen: () => boolean, onSelect: () => void, onDispose: () => void = () => {}) {
		this.native = native;
		this.theme = theme;
		this.getStatuses = getStatuses;
		this.panelOpen = panelOpen;
		this.onSelect = onSelect;
		this.onDispose = onDispose;
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
		const statuses = this.getStatuses();
		const label = sanitizeStatusText(statuses.get(WIDGET_KEY) ?? "");
		if (visibleWidth(label) === 0) return lines;
		lines.pop();

		const separator = this.theme.fg("dim", " · ");
		const peers = [...statuses.entries()]
			.filter(([key]) => key !== WIDGET_KEY)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, text]) => sanitizeStatusText(text))
			.filter((text) => visibleWidth(text) > 0)
			.join(separator);
		const styledLabel = this.theme.fg("accent", label);
		const hint = this.theme.fg("dim", " · Alt+J");
		let prefix = "";
		const renderedLabel = truncateToWidth(styledLabel, width, "");
		let suffix = renderedLabel;

		if (visibleWidth(renderedLabel) === visibleWidth(label)) {
			if (peers) {
				const withoutHint = peers + separator + renderedLabel;
				if (visibleWidth(withoutHint + hint) <= width) {
					prefix = peers + separator;
					suffix = renderedLabel + hint;
				} else if (visibleWidth(withoutHint) <= width) {
					prefix = peers + separator;
				} else {
					const available = width - visibleWidth(renderedLabel) - visibleWidth(separator);
					const truncatedPeers = truncateToWidth(peers, available, "…");
					if (visibleWidth(truncatedPeers) > 1) prefix = truncatedPeers + separator;
				}
			} else if (visibleWidth(renderedLabel + hint) <= width) {
				suffix = renderedLabel + hint;
			}
		}

		const hitWidth = visibleWidth(renderedLabel);
		if (hitWidth > 0) this.hit = { x: visibleWidth(prefix), y: lines.length, width: hitWidth };
		return [...lines, prefix + suffix];
	}

	invalidate(): void { this.hit = undefined; this.native.invalidate(); }

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hit = undefined;
		this.onDispose();
	}
}
