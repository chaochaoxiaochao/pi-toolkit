import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

export async function continueQueuedRun(runDirectory: string, herdr: HerdrAutomation, options: { cleanup?: boolean; onStalled?: (message: string) => void; onCleanupError?: (message: string) => void; signal?: AbortSignal } = {}): Promise<void> {
	const runFile = join(runDirectory, "run.json");
	const run = await readJson(runFile);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	const queuedDirectories: string[] = [];
	let blockedCount = 0;
	for (const directory of taskDirectories) {
		const status = (await readJson(join(directory, "task.json"))).status;
		if (status === "queued") queuedDirectories.push(directory);
		if (status === "blocked") blockedCount += 1;
	}
	if (!queuedDirectories.length) return;
	const availableSlots = Math.max(0, (Number(run.effectiveConcurrency) || 1) - blockedCount);
	if (availableSlots === 0) return;
	const concurrency = Math.min(availableSlots, queuedDirectories.length);
	const paneIds: string[] = Array.isArray(run.paneIds) ? [...run.paneIds] : [];
	let lastPaneId = paneIds.at(-1);
	let allocation = Promise.resolve();
	const allocate = async (directory: string): Promise<string> => {
		let paneId = "";
		allocation = allocation.then(async () => {
			const env = { PI_HERDR_SUBAGENTS_CHILD: "1", PI_HERDR_SUBAGENTS_TASK_DIR: directory };
			if (!run.tabId || !lastPaneId || !await herdr.paneExists(lastPaneId, options.signal)) {
				const tab = await retryBeforePrompt(() => herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: run.cwd, label: `SA · ${run.label}`, env, focus: false, signal: options.signal }));
				run.tabId = tab.tabId;
				paneId = tab.paneId;
			} else {
				const split = await retryBeforePrompt(() => herdr.splitPane({ paneId: lastPaneId as string, cwd: run.cwd, direction: paneIds.length % 2 ? "right" : "down", focus: false, env, signal: options.signal }));
				paneId = split.paneId;
			}
			lastPaneId = paneId;
			paneIds.push(paneId);
			run.paneIds = paneIds;
			run.status = "running";
			await writeJsonAtomic(runFile, run);
		});
		await allocation;
		return paneId;
	};
	let nextIndex = 0;
	const runOne = async (directory: string): Promise<string> => {
		const taskFile = join(directory, "task.json");
		const task = await readJson(taskFile);
		let paneId = "";
		try {
			paneId = await allocate(directory);
			const agentName = liveAgentName(task.id, Number(task.attempt ?? 0) + 1);
			const paneLabel = `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent}`;
			await herdr.renamePane(paneId, paneLabel, options.signal);
			Object.assign(task, { status: "running", tabId: run.tabId, paneId, paneLabel, agentName, attempt: Number(task.attempt ?? 0) + 1, startedAt: new Date().toISOString() });
			await writeJsonAtomic(taskFile, task);
			const { report } = await promptLiveAgent({ herdr, task: { ...task, id: task.id, sessionFile: task.sessionFile }, paneId, prompt: task.prompt, systemPromptFile: join(directory, "system-prompt.md"), agentName, signal: options.signal, stalledWarningMs: run.stalledWarningSeconds ? Number(run.stalledWarningSeconds) * 1000 : undefined, onStalled: () => options.onStalled?.(`${task.name ?? task.agent} appears stalled; it is still running.`) });
			Object.assign(task, { status: report.status === "needs-input" ? "blocked" : report.status, completedAt: new Date().toISOString(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
		} catch (error) {
			const cancelled = options.signal?.aborted === true;
			Object.assign(task, { status: cancelled ? "cancelled" : "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
			if (!existsSync(join(directory, "report.json"))) await writeJsonAtomic(join(directory, "report.json"), { status: "failed", summary: `${task.name ?? task.agent} failed.`, documents: [], error: task.error, reportedAt: new Date().toISOString() });
		}
		await writeJsonAtomic(taskFile, task);
		return task.status;
	};
	const worker = async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= queuedDirectories.length) return;
			if (await runOne(queuedDirectories[index]) === "blocked") return;
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	if (options.signal?.aborted) {
		for (const directory of taskDirectories) {
			const taskFile = join(directory, "task.json");
			const task = await readJson(taskFile);
			if (task.status !== "queued") continue;
			Object.assign(task, { status: "cancelled", completedAt: new Date().toISOString(), error: "Parent Pi session closed." });
			await writeJsonAtomic(taskFile, task);
		}
	}
	const statuses = await Promise.all(taskDirectories.map(async (directory) => (await readJson(join(directory, "task.json"))).status as string));
	run.status = statuses.some((status) => status === "blocked" || status === "queued") ? "blocked" : statuses.some((status) => status === "cancelled") ? "cancelled" : statuses.some((status) => status === "failed" || status === "interrupted") ? (statuses.some((status) => status === "completed") ? "partial" : "failed") : "completed";
	if (run.status === "blocked") run.updatedAt = new Date().toISOString();
	else run.completedAt = new Date().toISOString();
	await writeJsonAtomic(runFile, run);
	if (options.cleanup !== false && run.status !== "blocked" && run.tabId) {
		await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, signal: options.signal, onError: options.onCleanupError });
	}
}
