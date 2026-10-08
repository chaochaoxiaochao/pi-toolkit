import { readFile } from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BatchResult } from "./batch-runner.ts";
import type { TaskActivity } from "./records.ts";

type FleetKey = "up" | "down" | "enter" | "escape";
type KeyMatcher = (data: string, key: FleetKey) => boolean;

const legacyKeys: Record<FleetKey, string> = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b" };
const legacyMatchesKey: KeyMatcher = (data, key) => data === legacyKeys[key];

export interface FleetInputResult { consume?: boolean; focusTask?: number; changed?: boolean; }
export interface FleetTaskMetrics { tokens?: number; }
export type FleetMetrics = ReadonlyMap<number, FleetTaskMetrics>;

export function fleetEditorHasFocus(focused: unknown, isEditor: (value: unknown) => boolean): boolean {
	return isEditor(focused);
}

export class FleetSelection {
	private selected = 0;
	private selecting = false;
	private readonly matchesKey: KeyMatcher;

	constructor(matchesKey: KeyMatcher = legacyMatchesKey) { this.matchesKey = matchesKey; }

	reset(): void { this.selected = 0; this.selecting = false; }
	isSelecting(): boolean { return this.selecting; }
	selectedIndex(taskCount: number): number { return Math.min(this.selected, Math.max(0, taskCount - 1)); }

	handle(data: string, editorText: string, taskCount: number): FleetInputResult {
		if (taskCount === 0) { this.reset(); return {}; }
		this.selected = this.selectedIndex(taskCount);
		if (!this.selecting) {
			if (!this.matchesKey(data, "down") || editorText.length !== 0) return {};
			this.selecting = true;
			this.selected = 0;
			return { consume: true, changed: true };
		}
		if (this.matchesKey(data, "up") || this.matchesKey(data, "down")) {
			const delta = this.matchesKey(data, "up") ? -1 : 1;
			this.selected = (this.selected + delta + taskCount) % taskCount;
			return { consume: true, changed: true };
		}
		if (this.matchesKey(data, "enter")) return { consume: true, focusTask: this.selectedIndex(taskCount) + 1 };
		if (this.matchesKey(data, "escape")) { this.selecting = false; return { consume: true, changed: true }; }
		this.selecting = false;
		return { changed: true };
	}
}

function finiteTokenPart(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageTokens(value: unknown): number {
	if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
	const usage = value as Record<string, unknown>;
	return finiteTokenPart(usage.input) + finiteTokenPart(usage.output) + finiteTokenPart(usage.cacheRead) + finiteTokenPart(usage.cacheWrite);
}

/** Match Pi's cumulative footer semantics without trusting an incomplete JSONL tail. */
export function aggregateSessionTokens(jsonl: string): number {
	let total = 0;
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			entry = parsed as Record<string, unknown>;
		} catch { continue; }
		if (entry.type === "usage") total += usageTokens(entry.usage);
		else if (entry.type === "compaction" || entry.type === "branch_summary") total += usageTokens(entry.usage);
		else if (entry.type === "message") {
			const message = entry.message;
			if (!message || typeof message !== "object" || Array.isArray(message)) continue;
			const record = message as Record<string, unknown>;
			if (record.role === "assistant" || record.role === "toolResult") total += usageTokens(record.usage);
		}
	}
	return total;
}

export async function readSessionTokens(path: string): Promise<number | undefined> {
	try { return aggregateSessionTokens(await readFile(path, "utf8")); }
	catch { return undefined; }
}

export function formatFleetDuration(task: TaskActivity, now = Date.now()): string | undefined {
	if (!task.startedAt || task.status === "queued" || task.status === "starting") return undefined;
	let elapsed = typeof task.elapsedMs === "number" && Number.isFinite(task.elapsedMs) ? Math.max(0, task.elapsedMs) : undefined;
	if (task.status === "running" && task.activeStartedAt) {
		const activeStarted = Date.parse(task.activeStartedAt);
		if (Number.isFinite(activeStarted) && now >= activeStarted) elapsed = (elapsed ?? 0) + (now - activeStarted);
	}
	if (elapsed === undefined) {
		const started = Date.parse(task.startedAt);
		const terminal = task.completedAt ?? (task.status === "blocked" ? task.updatedAt : undefined);
		const ended = terminal ? Date.parse(terminal) : now;
		if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
		elapsed = ended - started;
	}
	const seconds = Math.floor(elapsed / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatFleetTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens} tok`;
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k tok`;
	return `${(tokens / 1_000_000).toFixed(1)}m tok`;
}

function statusSummary(activity: TaskActivity[]): string {
	const counts = new Map<string, number>();
	for (const task of activity) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	return ["running", "queued", "blocked", "failed", "completed", "cancelled"]
		.filter((status) => counts.has(status)).map((status) => `${status} ${counts.get(status)}`).join(" · ");
}

function fitColumns(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 >= width) return truncateToWidth(left, width);
	const fittedLeft = truncateToWidth(left, width - rightWidth - 1);
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return truncateToWidth(fittedLeft + gap + right, width);
}

type FleetTheme = Pick<Theme, "fg" | "bold">;
const plainTheme: FleetTheme = { fg: (_color, text) => text, bold: (text) => text } as FleetTheme;

export function fleetLines(
	batch: Pick<BatchResult, "label" | "activity">,
	selection: FleetSelection,
	options: { width?: number; now?: number; metrics?: FleetMetrics; theme?: FleetTheme } = {},
): string[] {
	const width = Math.max(1, options.width ?? 120);
	const theme = options.theme ?? plainTheme;
	const selected = selection.selectedIndex(batch.activity.length);
	const title = `─ ${theme.bold("Fleet")} · ${batch.label} · ${statusSummary(batch.activity)} `;
	const titleWidth = visibleWidth(title);
	const lines = [truncateToWidth(title + "─".repeat(Math.max(0, width - titleWidth)), width)];
	const rows = batch.activity.map((task, index) => {
		const chosen = selection.isSelecting() && index === selected;
		const circle = task.status === "queued" || task.status === "starting" ? "○" : "●";
		const color = task.status === "completed" ? "success" : task.status === "running" ? "warning" : task.status === "failed" ? "error" : task.status === "blocked" ? "warning" : task.status === "cancelled" ? "dim" : "accent";
		const marker = chosen ? theme.fg("accent", "›") : " ";
		const persona = theme.fg("muted", task.agent || "worker");
		const left = `${marker} ${theme.fg(color, circle)} ${persona}  ${task.name}  ${theme.fg("dim", task.status)}`;
		const duration = formatFleetDuration(task, options.now);
		const tokens = task.status === "queued" || task.status === "starting" ? undefined : options.metrics?.get(task.index)?.tokens;
		const right = [duration, tokens === undefined ? undefined : formatFleetTokens(tokens)].filter(Boolean).join("  ");
		return { left, right: theme.fg("dim", right) };
	});
	const maxLeft = Math.max(0, ...rows.map(({ left }) => visibleWidth(left)));
	const maxRight = Math.max(0, ...rows.map(({ right }) => visibleWidth(right)));
	const contentWidth = Math.min(width, maxLeft + (maxRight ? 2 + maxRight : 0));
	for (const row of rows) lines.push(fitColumns(row.left, row.right, contentWidth));
	return lines;
}
