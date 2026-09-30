import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrSubagentsToolParams } from "./tool.ts";
import { isProcessAlive } from "./ownership.ts";
import { writeJsonAtomic } from "./state.ts";

export interface QueuedRunRecord { runId: string; cwd: string; ownerSessionId?: string; ownerProcessId?: number; params: HerdrSubagentsToolParams; queuedAt: string; }
function queueDirectory(cwd: string): string { return join(cwd, ".pi", "herdr-subagents", "queue"); }

export async function persistQueuedRun(cwd: string, runId: string, params: HerdrSubagentsToolParams, ownerSessionId?: string, ownerProcessId?: number): Promise<void> {
	const directory = queueDirectory(cwd);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeJsonAtomic(join(directory, `${runId}.json`), { runId, cwd, ownerSessionId, ownerProcessId, params: { ...params, background: true }, queuedAt: new Date().toISOString() });
}

export async function removeQueuedRun(cwd: string, runId: string): Promise<void> {
	await rm(join(queueDirectory(cwd), `${runId}.json`), { force: true });
}

export async function loadQueuedRuns(cwd: string): Promise<QueuedRunRecord[]> {
	const directory = queueDirectory(cwd);
	if (!existsSync(directory)) return [];
	const records: QueuedRunRecord[] = [];
	for (const entry of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
		try { records.push(JSON.parse(await readFile(join(directory, entry), "utf8")) as QueuedRunRecord); } catch {}
	}
	return records.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export async function cancelQueuedRuns(cwd: string, runIds: string[], reason = "Parent Pi session closed.", ownerSessionId?: string, onlyOrphaned = false): Promise<void> {
	const selected = new Set(runIds);
	for (const queued of await loadQueuedRuns(cwd)) {
		if (!selected.has(queued.runId)) continue;
		if (ownerSessionId && queued.ownerSessionId !== ownerSessionId) continue;
		if (onlyOrphaned && isProcessAlive(queued.ownerProcessId)) continue;
		const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
		const alreadyPersisted = existsSync(runsDirectory) && readdirSync(runsDirectory).some((entry) => {
			try { return JSON.parse(readFileSync(join(runsDirectory, entry, "run.json"), "utf8")).id === queued.runId; }
			catch { return false; }
		});
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
