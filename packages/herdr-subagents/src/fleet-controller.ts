import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { HerdrAutomation } from "./herdr.ts";
import { fleetEditorHasFocus, FleetSelection, fleetLines, readSessionTokens, type FleetTaskMetrics } from "./fleet.ts";
import { focusActiveTask } from "./monitor.ts";
import { isActiveStatus } from "./records.ts";
import type { HerdrSubagentsBatchDetails } from "./tool.ts";

interface Closable { close(): void; }
export interface FleetWidgetRuntime {
	watchSession(path: string, onChange: () => void, onError: () => void): Closable;
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	readTokens(path: string): Promise<number | undefined>;
}

const defaultFleetWidgetRuntime: FleetWidgetRuntime = {
	watchSession(path, onChange, onError) {
		const watcher = watch(dirname(path), (_event, filename) => {
			if (!filename || filename.toString() === basename(path)) onChange();
		});
		watcher.on("error", () => { watcher.close(); onError(); });
		return watcher;
	},
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	readTokens: readSessionTokens,
};

export class FleetWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly selection: FleetSelection;
	private readonly runtime: FleetWidgetRuntime;
	private batch: HerdrSubagentsBatchDetails;
	private readonly metrics = new Map<number, FleetTaskMetrics>();
	private readonly watchers = new Map<string, Closable>();
	private elapsedTimer?: unknown;
	private refreshTimer?: unknown;
	private generation = 0;
	private disposed = false;
	private sourceKey = "";

	constructor(tui: TUI, theme: Theme, batch: HerdrSubagentsBatchDetails, selection: FleetSelection, runtime: FleetWidgetRuntime = defaultFleetWidgetRuntime) {
		this.tui = tui;
		this.theme = theme;
		this.selection = selection;
		this.runtime = runtime;
		this.batch = batch;
		this.configureLiveUpdates();
	}

	update(batch: HerdrSubagentsBatchDetails): void {
		if (this.disposed) return;
		this.batch = batch;
		this.configureLiveUpdates();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return fleetLines(this.batch, this.selection, { width, metrics: this.metrics, theme: this.theme });
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		if (this.elapsedTimer) this.runtime.clearInterval(this.elapsedTimer);
		if (this.refreshTimer) this.runtime.clearTimeout(this.refreshTimer);
		this.elapsedTimer = undefined;
		this.refreshTimer = undefined;
	}

	private configureLiveUpdates(): void {
		const sessionFiles = new Set(this.batch.activity.map((task) => task.sessionFile).filter((path): path is string => Boolean(path)));
		const nextSourceKey = `${this.batch.runId}\n${[...sessionFiles].sort().join("\n")}`;
		if (nextSourceKey !== this.sourceKey) {
			this.sourceKey = nextSourceKey;
			this.generation += 1;
			this.metrics.clear();
		}
		for (const [path, watcher] of this.watchers) {
			if (sessionFiles.has(path)) continue;
			watcher.close();
			this.watchers.delete(path);
		}
		for (const path of sessionFiles) {
			if (this.watchers.has(path)) continue;
			try {
				const watcher = this.runtime.watchSession(path, () => this.scheduleMetricsRefresh(), () => this.watchers.delete(path));
				this.watchers.set(path, watcher);
			} catch { /* The next durable activity update can retry the watch. */ }
		}
		const hasRunning = this.batch.activity.some((task) => task.status === "running");
		if (hasRunning && !this.elapsedTimer) this.elapsedTimer = this.runtime.setInterval(() => {
			this.tui.requestRender();
			this.scheduleMetricsRefresh(0);
		}, 1_000);
		else if (!hasRunning && this.elapsedTimer) { this.runtime.clearInterval(this.elapsedTimer); this.elapsedTimer = undefined; }
		this.scheduleMetricsRefresh(0);
	}

	private scheduleMetricsRefresh(delay = 25): void {
		if (this.disposed) return;
		if (this.refreshTimer) this.runtime.clearTimeout(this.refreshTimer);
		this.refreshTimer = this.runtime.setTimeout(() => { this.refreshTimer = undefined; void this.refreshMetrics(); }, delay);
	}

	private async refreshMetrics(): Promise<void> {
		const generation = ++this.generation;
		const next = await Promise.all(this.batch.activity.map(async (task) => ({ index: task.index, tokens: task.sessionFile ? await this.runtime.readTokens(task.sessionFile) : undefined })));
		if (this.disposed || generation !== this.generation) return;
		this.metrics.clear();
		for (const metric of next) if (metric.tokens !== undefined) this.metrics.set(metric.index, { tokens: metric.tokens });
		this.tui.requestRender();
	}
}

export class FleetController {
	private readonly herdr: HerdrAutomation;
	private readonly isEditor: (value: unknown) => boolean;
	private readonly createWidget?: (lines: string[]) => Container;
	private readonly widgetRuntime: FleetWidgetRuntime;
	private activeBatch?: HerdrSubagentsBatchDetails;
	private readonly selection = new FleetSelection(matchesKey);
	private unsubscribeInput?: () => void;
	private ui?: ExtensionUIContext;
	private tui?: TUI;
	private widget?: FleetWidget;

	constructor(herdr: HerdrAutomation, isEditor: (value: unknown) => boolean, createWidget?: (lines: string[]) => Container, widgetRuntime: FleetWidgetRuntime = defaultFleetWidgetRuntime) {
		this.herdr = herdr;
		this.isEditor = isEditor;
		this.createWidget = createWidget;
		this.widgetRuntime = widgetRuntime;
	}

	get active(): HerdrSubagentsBatchDetails | undefined { return this.activeBatch; }

	bind(ui: ExtensionUIContext, tuiMode: boolean): void {
		this.unsubscribeInput?.();
		if (this.ui && this.ui !== ui) {
			this.ui.setWidget("herdr-subagents", undefined, { placement: "belowEditor" });
			this.widget = undefined;
			this.tui = undefined;
		}
		this.ui = ui;
		this.unsubscribeInput = tuiMode ? ui.onTerminalInput((data) => this.handleInput(data)) : undefined;
		if (this.activeBatch) this.render();
	}

	sync(details: unknown): void {
		if (!this.ui) return;
		const batch = details as Partial<HerdrSubagentsBatchDetails>;
		if (!batch.activity || !batch.label || !batch.status) return;
		if (this.activeBatch && batch.runId !== this.activeBatch.runId) return;
		if (this.activeBatch?.runId !== batch.runId) this.selection.reset();
		this.activeBatch = isActiveStatus(batch.status) ? batch as HerdrSubagentsBatchDetails : undefined;
		this.render();
	}

	setActive(batch: HerdrSubagentsBatchDetails | undefined): void {
		if (!this.ui) return;
		if (this.activeBatch?.runId !== batch?.runId) this.selection.reset();
		this.activeBatch = batch;
		this.render();
	}

	clearRun(runId?: string): void {
		if (!runId || this.activeBatch?.runId === runId) this.activeBatch = undefined;
		this.render();
	}

	resetSelection(): void { this.selection.reset(); this.render(); }
	async focus(taskNumber: number): Promise<boolean> { return this.activeBatch ? focusActiveTask(this.activeBatch, taskNumber, this.herdr) : false; }

	shutdown(): void {
		this.unsubscribeInput?.();
		this.unsubscribeInput = undefined;
		this.activeBatch = undefined;
		this.selection.reset();
		this.render();
		this.ui = undefined;
		this.widget = undefined;
		this.tui = undefined;
	}

	render(): void {
		if (!this.ui) return;
		if (!this.activeBatch) {
			this.widget = undefined;
			this.ui.setWidget("herdr-subagents", undefined, { placement: "belowEditor" });
			return;
		}
		if (this.createWidget) {
			this.ui.setWidget("herdr-subagents", (tui) => {
				this.tui = tui;
				return this.createWidget?.(fleetLines(this.activeBatch as HerdrSubagentsBatchDetails, this.selection)) ?? new Container();
			}, { placement: "belowEditor" });
			return;
		}
		if (this.widget) { this.widget.update(this.activeBatch); return; }
		this.ui.setWidget("herdr-subagents", (tui, theme) => {
			this.tui = tui;
			this.widget = new FleetWidget(tui, theme, this.activeBatch as HerdrSubagentsBatchDetails, this.selection, this.widgetRuntime);
			return this.widget;
		}, { placement: "belowEditor" });
	}

	private handleInput(data: string): { consume: true } | undefined {
		if (!this.activeBatch || isKeyRelease(data)) return undefined;
		if (!fleetEditorHasFocus(this.tui?.focusedComponent, this.isEditor)) {
			this.selection.reset();
			this.render();
			return undefined;
		}
		const result = this.selection.handle(data, this.ui?.getEditorText() ?? "", this.activeBatch.activity.length);
		if (result.changed) this.render();
		if (result.focusTask) void focusActiveTask(this.activeBatch, result.focusTask, this.herdr);
		return result.consume ? { consume: true } : undefined;
	}
}
