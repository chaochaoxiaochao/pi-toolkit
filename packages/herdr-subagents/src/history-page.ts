import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRunRecord, type RunStatus } from "./records.ts";

export interface HistoryIndexRun {
	id: string;
	label: string;
	status: RunStatus;
	startedAt: string;
	completedAt?: string;
	taskCount: number | null;
	error?: string;
}

export interface HistoryPage {
	runs: HistoryIndexRun[];
	hasMore: boolean;
	nextCursor?: string;
}

function parseHistoryCursor(cursor: string): { startedAt: string; id: string } {
	if (typeof cursor !== "string" || !cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid history cursor.");
	let value: unknown;
	try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
	catch { throw new Error("Invalid history cursor."); }
	if (!value || typeof value !== "object") throw new Error("Invalid history cursor.");
	const key = value as Record<string, unknown>;
	if (key.v !== 1 || typeof key.startedAt !== "string" || typeof key.id !== "string" || !key.id
		|| key.id.length > 255 || (key.startedAt !== "" && (!Number.isFinite(Date.parse(key.startedAt)) || new Date(key.startedAt).toISOString() !== key.startedAt))) throw new Error("Invalid history cursor.");
	return { startedAt: key.startedAt, id: key.id };
}

// Sorting only run metadata avoids reading every task/report to build an index.
// This still scans O(runs) small records; add a persistent index only if needed.
export async function listSubagentHistoryPage(cwd: string, options: { limit?: number; cursor?: string } = {}): Promise<HistoryPage> {
	const limit = options.limit === undefined ? 10 : options.limit;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be an integer from 1 through 50.");
	const after = options.cursor === undefined ? undefined : parseHistoryCursor(options.cursor);
	const directory = join(cwd, ".pi", "herdr-subagents", "runs");
	let entries;
	try { entries = await readdir(directory, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], hasMore: false }; throw error; }
	const runs: HistoryIndexRun[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const run = await readRunRecord(join(directory, entry.name, "run.json"));
			if (run.id.length > 255 || (run.taskIds !== undefined && (!Array.isArray(run.taskIds) || run.taskIds.some((id) => typeof id !== "string")))
				|| (run.startedAt !== undefined && typeof run.startedAt !== "string") || (run.completedAt !== undefined && typeof run.completedAt !== "string")) throw new Error("Invalid run index metadata.");
			const startedAt = run.startedAt === undefined ? "" : new Date(run.startedAt).toISOString();
			runs.push({ id: run.id, label: run.label.slice(0, 48), status: run.status, startedAt, ...(run.completedAt ? { completedAt: new Date(run.completedAt).toISOString() } : {}), taskCount: run.taskIds?.length ?? null });
		} catch {
			runs.push({ id: entry.name, label: "Unreadable Subagent run", status: "failed", startedAt: "", taskCount: null, error: "Invalid run metadata; inspect this run with status." });
		}
	}
	const compare = (a: { startedAt: string; id: string }, b: { startedAt: string; id: string }) =>
		a.startedAt === b.startedAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.startedAt < b.startedAt ? 1 : -1);
	runs.sort(compare);
	const remaining = after ? runs.filter((run) => compare(run, after) > 0) : runs;
	const page = remaining.slice(0, limit);
	const hasMore = remaining.length > limit;
	const last = page.at(-1);
	return { runs: page, hasMore, ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, startedAt: last.startedAt, id: last.id })).toString("base64url") } : {}) };
}

export function historyPageText(page: HistoryPage): string {
	const lines = page.runs.map((run) => `${run.id} · ${run.label} · ${run.status} · ${run.taskCount ?? "unknown"} tasks · ${run.startedAt || "unknown time"}${run.error ? ` · ${run.error}` : ""}`);
	if (!lines.length) lines.push("No Subagent history on this page.");
	if (page.nextCursor) lines.push(`More history: action=history, cursor=${page.nextCursor} (nextCursor).`);
	if (page.runs.length) lines.push("Use action=status with a runId for task details.");
	return lines.join("\n");
}
