import type { HerdrAutomation } from "./herdr.ts";
import { withRunStateLock } from "./run-state.ts";
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
			const allocated = await withRunStateLock(runFile, signal, async (latest) => {
				const currentPaneIds = [...(latest.paneIds ?? [])];
				let lastPaneId = currentPaneIds.at(-1);
				let anchorExists = Boolean(latest.tabId && lastPaneId);
				if (anchorExists && this.options.validateExistingPane) {
					const surviving: string[] = [];
					for (const existingPaneId of currentPaneIds) if (await herdr.paneExists(existingPaneId, signal)) surviving.push(existingPaneId);
					currentPaneIds.splice(0, currentPaneIds.length, ...surviving);
					lastPaneId = currentPaneIds.at(-1);
					anchorExists = Boolean(lastPaneId);
				}
				let staleTabId: string | undefined;
				if (!anchorExists) {
					staleTabId = latest.tabId;
					const tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: latest.cwd, label: `SA · ${latest.label}`, env, focus: false, signal });
					latest.tabId = tab.tabId;
					paneId = tab.paneId;
					currentPaneIds.splice(0);
					if (staleTabId && staleTabId !== tab.tabId) latest.staleTabIds = [...new Set([...(latest.staleTabIds ?? []), staleTabId])];
				} else {
					paneId = (await herdr.splitPane({ paneId: lastPaneId as string, cwd: latest.cwd, direction: currentPaneIds.length % 2 ? "right" : "down", focus: false, env, signal })).paneId;
				}
				currentPaneIds.push(paneId);
				applyRunStatus(latest, "running");
				latest.paneIds = currentPaneIds;
				return { latest, staleTabId: staleTabId && staleTabId !== latest.tabId ? staleTabId : undefined };
			});
			this.paneIds.splice(0, this.paneIds.length, ...(allocated.latest.paneIds ?? []));
			this.lastPaneId = this.paneIds.at(-1);
			Object.assign(run, allocated.latest);
			if (allocated.staleTabId) {
				const staleTabId = allocated.staleTabId;
				await cleanupRunTab({
					herdr, tabId: staleTabId, runFile, runRecord: run, signal, onError: this.options.onCleanupError,
					errorPrefix: `Could not close stale Herdr tab ${staleTabId}`,
					onClosed: (latest) => {
						latest.staleTabIds = latest.staleTabIds?.filter((id) => id !== staleTabId);
						if (!latest.staleTabIds?.length) delete latest.staleTabIds;
					},
				}).catch((error) => { if (!this.options.onCleanupError) throw error; });
			}
		});
		await this.allocation;
		return paneId;
	}
}
