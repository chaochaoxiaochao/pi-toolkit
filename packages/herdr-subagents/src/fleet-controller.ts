import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, matchesKey, Text } from "@earendil-works/pi-tui";
import type { HerdrAutomation } from "./herdr.ts";
import { fleetEditorHasFocus, FleetSelection, fleetLines } from "./fleet.ts";
import { focusActiveTask } from "./monitor.ts";
import { isActiveStatus } from "./records.ts";
import type { HerdrSubagentsBatchDetails } from "./tool.ts";

export class FleetController {
	private activeBatch?: HerdrSubagentsBatchDetails;
	private readonly selection = new FleetSelection(matchesKey);
	private unsubscribeInput?: () => void;
	private ui?: ExtensionUIContext;
	private tui?: { focusedComponent?: unknown };

	constructor(
		private readonly herdr: HerdrAutomation,
		private readonly isEditor: (value: unknown) => boolean,
		private readonly createWidget?: (lines: string[]) => Container,
	) {}

	get active(): HerdrSubagentsBatchDetails | undefined { return this.activeBatch; }

	bind(ui: ExtensionUIContext, tuiMode: boolean): void {
		this.unsubscribeInput?.();
		this.ui = ui;
		this.unsubscribeInput = tuiMode ? ui.onTerminalInput((data) => this.handleInput(data)) : undefined;
	}

	sync(details: unknown): void {
		const batch = details as Partial<HerdrSubagentsBatchDetails>;
		if (!batch.activity || !batch.label || !batch.status) return;
		this.activeBatch = isActiveStatus(batch.status) ? batch as HerdrSubagentsBatchDetails : undefined;
		this.render();
	}

	setActive(batch: HerdrSubagentsBatchDetails | undefined): void {
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
	}

	render(): void {
		if (!this.ui) return;
		this.ui.setWidget("herdr-subagents", this.activeBatch ? ((tui) => {
			this.tui = tui as { focusedComponent?: unknown };
			const lines = fleetLines(this.activeBatch as HerdrSubagentsBatchDetails, this.selection);
			if (this.createWidget) return this.createWidget(lines);
			const container = new Container();
			for (const line of lines) container.addChild(new Text(line, 1, 0));
			return container;
		}) : undefined, { placement: "belowEditor" });
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
