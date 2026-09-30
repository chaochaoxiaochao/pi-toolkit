import { retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic } from "./state.ts";

interface RunPaneAllocatorOptions {
	herdr: HerdrAutomation;
	run: Record<string, any>;
	runFile: string;
	signal?: AbortSignal;
	validateExistingPane?: boolean;
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

	get tabId(): string | undefined { return this.options.run.tabId as string | undefined; }

	async allocate(taskDirectory: string): Promise<string> {
		let paneId = "";
		this.allocation = this.allocation.then(async () => {
			const { herdr, run, runFile, signal } = this.options;
			const env = { PI_HERDR_SUBAGENTS_CHILD: "1", PI_HERDR_SUBAGENTS_TASK_DIR: taskDirectory };
			const anchorExists = Boolean(run.tabId && this.lastPaneId)
				&& (!this.options.validateExistingPane || await herdr.paneExists(this.lastPaneId as string, signal));
			if (!anchorExists) {
				const tab = await retryBeforePrompt(() => herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: run.cwd, label: `SA · ${run.label}`, env, focus: false, signal }));
				run.tabId = tab.tabId;
				paneId = tab.paneId;
			} else {
				const split = await retryBeforePrompt(() => herdr.splitPane({ paneId: this.lastPaneId as string, cwd: run.cwd, direction: this.paneIds.length % 2 ? "right" : "down", focus: false, env, signal }));
				paneId = split.paneId;
			}
			this.lastPaneId = paneId;
			this.paneIds.push(paneId);
			Object.assign(run, { status: "running", paneIds: [...this.paneIds] });
			await writeJsonAtomic(runFile, run);
		});
		await this.allocation;
		return paneId;
	}
}
