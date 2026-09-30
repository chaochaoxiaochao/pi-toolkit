import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrSubagentsToolParams } from "./tool.ts";
import { isProcessAlive, ownerRecord, type OwnerIdentity } from "./ownership.ts";
import { writeJsonAtomic } from "./state.ts";
import { findRunDirectory } from "./run-locator.ts";

export interface QueuedRunRecord { runId: string; cwd: string; ownerSessionId?: string; ownerProcessId?: number; params: HerdrSubagentsToolParams; queuedAt: string; }
function queueDirectory(cwd: string): string { return join(cwd, ".pi", "herdr-subagents", "queue"); }

export async function persistQueuedRun(cwd: string, runId: string, params: HerdrSubagentsToolParams, owner?: OwnerIdentity): Promise<void> {
	const directory = queueDirectory(cwd);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeJsonAtomic(join(directory, `${runId}.json`), { runId, cwd, ...ownerRecord(owner), params: { ...params, background: true }, queuedAt: new Date().toISOString() });
}

export async function removeQueuedRun(cwd: string, runId: string): Promise<void> {
	await rm(join(queueDirectory(cwd), `${runId}.json`), { force: true });
}

export async function loadQueuedRuns(cwd: string, onError?: (message: string) => void): Promise<QueuedRunRecord[]> {
	const directory = queueDirectory(cwd);
	if (!existsSync(directory)) return [];
	const records: QueuedRunRecord[] = [];
	for (const entry of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
		const path = join(directory, entry);
		try { records.push(JSON.parse(await readFile(path, "utf8")) as QueuedRunRecord); }
		catch (error) {
			const message = `Could not read queued Subagent run ${path}: ${error instanceof Error ? error.message : String(error)}`;
			if (!onError) throw new Error(message);
			onError(message);
		}
	}
	return records.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export interface CancelQueuedRunsOptions { reason?: string; owner?: OwnerIdentity; onlyOrphaned?: boolean; onError?: (message: string) => void; }

export async function cancelQueuedRuns(cwd: string, runIds: string[], options: CancelQueuedRunsOptions = {}): Promise<void> {
	const reason = options.reason ?? "Parent Pi session closed.";
	const selected = new Set(runIds);
	for (const queued of await loadQueuedRuns(cwd, options.onError)) {
		if (!selected.has(queued.runId)) continue;
		if (!options.onlyOrphaned && options.owner?.sessionId && queued.ownerSessionId !== options.owner.sessionId) continue;
		if (options.onlyOrphaned) {
			const differentOwner = options.owner?.sessionId !== undefined && queued.ownerSessionId !== options.owner.sessionId;
			if (!differentOwner) continue;
			const ownedByAnotherLiveProcess = queued.ownerProcessId !== (options.owner?.processId ?? process.pid) && isProcessAlive(queued.ownerProcessId);
			if (ownedByAnotherLiveProcess) continue;
		}
		const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
		const alreadyPersisted = Boolean(await findRunDirectory(runsDirectory, queued.runId));
		if (alreadyPersisted) { await removeQueuedRun(cwd, queued.runId); continue; }
		const now = new Date().toISOString();
		const runDirectory = join(cwd, ".pi", "herdr-subagents", "runs", `${now.replace(/[-:.]/g, "").replace("Z", "Z-")}${queued.runId.slice(0, 8)}`);
		const tasks = queued.params.tasks ?? [];
		await mkdir(join(runDirectory, "tasks"), { recursive: true, mode: 0o700 });
		const taskIds: string[] = [];
		for (const [index, task] of tasks.entries()) {
			const id = `${queued.runId}-queued-${index + 1}`;
			taskIds.push(id);
			const directory = join(runDirectory, "tasks", `${String(index + 1).padStart(2, "0")}-queued`);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeJsonAtomic(join(directory, "task.json"), { id, runId: queued.runId, order: index + 1, name: task.name, prompt: task.prompt, agent: task.agent ?? "worker", model: task.model, status: "cancelled", error: reason, sessionFile: join(directory, "session.jsonl"), startedAt: queued.queuedAt, completedAt: now });
		}
		await writeJsonAtomic(join(runDirectory, "run.json"), { id: queued.runId, label: queued.params.label ?? "batch", status: "cancelled", cwd, ownerSessionId: queued.ownerSessionId, ownerProcessId: queued.ownerProcessId, taskIds, startedAt: queued.queuedAt, completedAt: now, error: reason });
		await removeQueuedRun(cwd, queued.runId);
	}
}
