import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TinySubagentToolParams } from "./tool.ts";
import { writeJsonAtomic } from "./state.ts";

export interface QueuedRunRecord { runId: string; cwd: string; params: TinySubagentToolParams; queuedAt: string; }
function queueDirectory(cwd: string): string { return join(cwd, ".pi", "herdr-subagents", "queue"); }

export async function persistQueuedRun(cwd: string, runId: string, params: TinySubagentToolParams): Promise<void> {
	const directory = queueDirectory(cwd);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeJsonAtomic(join(directory, `${runId}.json`), { runId, cwd, params: { ...params, runId, background: true }, queuedAt: new Date().toISOString() });
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
