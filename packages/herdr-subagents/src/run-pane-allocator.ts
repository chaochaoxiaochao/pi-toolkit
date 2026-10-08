import type { HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic } from "./state.ts";
import type { RunRecord } from "./records.ts";
import { applyRunStatus } from "./run-status.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { childEnvironment } from "./live-agent.ts";

interface RunPaneAllocatorOptions {
	herdr: HerdrAutomation;
	run: RunRecord;
	runFile: string;
	signal?: AbortSignal;
	validateExistingPane?: boolean;
	onCleanupError?: (message: string) => void;
}

export class RunPaneAllocator {
	private allocation = Promise.resolve();
	private readonly paneIds: string[];
	private lastPaneId?: string;
	private readonly options: RunPaneAllocatorOptions;

	constructor(options: RunPaneAllocatorOptions) {
		this.options = options;
		this.paneIds = Array.isArray(options.run.paneIds) ? [...options.run.paneIds] : [];
		this.lastPaneId = this.paneIds.at(-1);
	}

	get tabId(): string | undefined { return this.options.run.tabId; }

	async allocate(taskDirectory: string): Promise<string> {
		let paneId = "";
		this.allocation = this.allocation.then(async () => {
			const { herdr, run, runFile, signal } = this.options;
			const env = childEnvironment(taskDirectory);
			let anchorExists = Boolean(run.tabId && this.lastPaneId);
			if (anchorExists && this.options.validateExistingPane) {
				const survivingPaneIds: string[] = [];
				for (const existingPaneId of this.paneIds) {
					if (await herdr.paneExists(existingPaneId, signal)) survivingPaneIds.push(existingPaneId);
				}
				this.paneIds.splice(0, this.paneIds.length, ...survivingPaneIds);
				this.lastPaneId = this.paneIds.at(-1);
				anchorExists = Boolean(this.lastPaneId);
			}
			if (!anchorExists) {
				const staleTabId = run.tabId;
				const tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: run.cwd, label: `SA · ${run.label}`, env, focus: false, signal });
				run.tabId = tab.tabId;
				paneId = tab.paneId;
				this.paneIds.splice(0);
				if (staleTabId && staleTabId !== tab.tabId) {
					run.staleTabIds = [...new Set([...(run.staleTabIds ?? []), staleTabId])];
					await writeJsonAtomic(runFile, run);
					await cleanupRunTab({
						herdr, tabId: staleTabId, runFile, runRecord: run, signal, onError: this.options.onCleanupError,
						errorPrefix: `Could not close stale Herdr tab ${staleTabId}`,
							onClosed: (latest) => {
							latest.staleTabIds = latest.staleTabIds?.filter((id) => id !== staleTabId);
							if (!latest.staleTabIds?.length) delete latest.staleTabIds;
						},
					}).catch((error) => {
						if (!this.options.onCleanupError) throw error;
					});
				}
			} else {
				const split = await herdr.splitPane({ paneId: this.lastPaneId as string, cwd: run.cwd, direction: this.paneIds.length % 2 ? "right" : "down", focus: false, env, signal });
				paneId = split.paneId;
			}
			this.lastPaneId = paneId;
			this.paneIds.push(paneId);
			applyRunStatus(run, "running");
			run.paneIds = [...this.paneIds];
			await writeJsonAtomic(runFile, run);
		});
		await this.allocation;
		return paneId;
	}
}
