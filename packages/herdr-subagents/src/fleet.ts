import type { BatchResult } from "./batch-runner.ts";

type FleetKey = "up" | "down" | "enter" | "escape";
type KeyMatcher = (data: string, key: FleetKey) => boolean;

const legacyKeys: Record<FleetKey, string> = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b" };
const legacyMatchesKey: KeyMatcher = (data, key) => data === legacyKeys[key];

export interface FleetInputResult { consume?: boolean; focusTask?: number; changed?: boolean; }

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
		if (this.matchesKey(data, "enter")) return { consume: true, focusTask: this.selected + 1 };
		if (this.matchesKey(data, "escape")) { this.selecting = false; return { consume: true, changed: true }; }
		this.selecting = false;
		return { changed: true };
	}
}

export function fleetLines(batch: Pick<BatchResult, "label" | "activity">, selection: FleetSelection): string[] {
	const counts = new Map<string, number>();
	for (const task of batch.activity) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const summary = ["running", "queued", "blocked", "failed", "completed", "cancelled"]
		.filter((status) => counts.has(status)).map((status) => `${status} ${counts.get(status)}`).join(" · ");
	const selected = selection.selectedIndex(batch.activity.length);
	return [
		`Subagents · ${batch.label} · ${summary}`,
		...batch.activity.map((task, index) => `${selection.isSelecting() && index === selected ? "›" : " "} ${String(task.index + 1).padStart(2, "0")} · ${task.name}  ${task.status}`),
	];
}
