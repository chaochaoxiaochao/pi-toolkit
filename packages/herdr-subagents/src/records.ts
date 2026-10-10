import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { writeJsonAtomic } from "./state.ts";

export type TaskStatus = "starting" | "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type RunStatus = TaskStatus | "partial";
export const ACTIVE_STATUSES = new Set<RunStatus>(["starting", "queued", "running", "blocked"]);
const SETTLED_RUN_STATUSES = new Set<RunStatus>(["completed", "partial", "failed", "cancelled"]);

export function isActiveStatus(status: RunStatus): boolean { return ACTIVE_STATUSES.has(status); }
export function isSettledRunStatus(status: unknown): status is Exclude<RunStatus, "starting" | "queued" | "running" | "blocked"> { return SETTLED_RUN_STATUSES.has(status as RunStatus); }

export interface PersistedDocument {
	path: string;
	description: string;
}

export interface PersistedReport {
	status: "completed" | "needs-input" | "failed";
	summary: string;
	documents: PersistedDocument[];
	attemptId?: string;
	error?: string;
	question?: string;
	failureKind?: "missing_input";
	requiredInput?: string;
	reportedAt?: string;
}

export interface RunRecord {
	id: string;
	label: string;
	status: RunStatus;
	cwd?: string;
	ownerSessionId?: string;
	ownerProcessId?: number;
	requestedConcurrency?: number;
	effectiveConcurrency?: number;
	stalledWarningSeconds?: number;
	taskIds?: string[];
	paneIds?: string[];
	startedAt?: string;
	updatedAt?: string;
	completedAt?: string;
	tabId?: string;
	paneId?: string;
	staleTabIds?: string[];
	question?: string;
	error?: string;
	failureKind?: "missing_input";
	requiredInput?: string;
	cleanupError?: string;
	cleanupPendingTabIds?: string[];
}

export interface TaskRecord {
	id: string;
	runId: string;
	order: number;
	name?: string;
	status: TaskStatus;
	prompt?: string;
	agent?: string;
	access?: "read" | "write";
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	systemPrompt?: string;
	sessionFile?: string;
	startedAt?: string;
	activeStartedAt?: string;
	elapsedMs?: number;
	updatedAt?: string;
	completedAt?: string;
	tabId?: string;
	paneId?: string;
	paneLabel?: string;
	agentName?: string;
	attempt?: number;
	currentTurnFile?: string;
	currentAttemptId?: string;
	question?: string;
	error?: string;
}

export interface TaskActivity {
	index: number;
	name: string;
	status: TaskStatus;
	agent: string;
	prompt?: string;
	paneId?: string;
	sessionFile?: string;
	startedAt?: string;
	activeStartedAt?: string;
	elapsedMs?: number;
	completedAt?: string;
	updatedAt?: string;
}

export function projectTaskActivity(task: TaskRecord, index = task.order - 1): TaskActivity {
	return {
		index,
		name: String(task.name ?? task.agent ?? `Task ${index + 1}`),
		status: task.status,
		agent: String(task.agent ?? "worker"),
		...(task.prompt ? { prompt: task.prompt } : {}),
		...(task.paneId ? { paneId: task.paneId } : {}),
		...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
		...(task.startedAt ? { startedAt: task.startedAt } : {}),
		...(task.activeStartedAt ? { activeStartedAt: task.activeStartedAt } : {}),
		...(typeof task.elapsedMs === "number" ? { elapsedMs: task.elapsedMs } : {}),
		...(task.completedAt ? { completedAt: task.completedAt } : {}),
		...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
	};
}

export interface TurnRecord {
	attempt: number;
	prompt?: string;
	status: TaskStatus;
	summary?: string;
	documents?: PersistedDocument[];
	sessionFile?: string;
	startedAt?: string;
	completedAt?: string;
	tabId?: string;
	paneId?: string;
	agentName?: string;
	question?: string;
	error?: string;
	events?: Array<Record<string, unknown>>;
}

async function readObject(path: string): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON object in ${path}.`);
	return parsed as Record<string, unknown>;
}

const TASK_STATUSES = new Set<TaskStatus>(["starting", "queued", "running", "blocked", "completed", "failed", "cancelled"]);
const RUN_STATUSES = new Set<RunStatus>([...TASK_STATUSES, "partial"]);
function requireString(record: Record<string, unknown>, field: string, path: string): void {
	if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`Missing ${field} in ${path}.`);
}

export async function readRunRecord(path: string): Promise<RunRecord> {
	const record = await readObject(path);
	requireString(record, "id", path);
	requireString(record, "label", path);
	if (!RUN_STATUSES.has(record.status as RunStatus)) throw new Error(`Invalid run status in ${path}.`);
	return record as unknown as RunRecord;
}

export async function readTaskRecord(path: string): Promise<TaskRecord> {
	const record = await readObject(path);
	requireString(record, "id", path);
	requireString(record, "runId", path);
	if (!Number.isInteger(record.order) || Number(record.order) < 1) throw new Error(`Invalid task order in ${path}.`);
	if (!TASK_STATUSES.has(record.status as TaskStatus)) throw new Error(`Invalid task status in ${path}.`);
	return record as unknown as TaskRecord;
}

export async function readTurnRecord(path: string): Promise<TurnRecord> {
	const record = await readObject(path);
	if (!Number.isInteger(record.attempt) || Number(record.attempt) < 1) throw new Error(`Invalid turn attempt in ${path}.`);
	if (!TASK_STATUSES.has(record.status as TaskStatus)) throw new Error(`Invalid turn status in ${path}.`);
	return record as unknown as TurnRecord;
}

export function parseReport(value: unknown, source = "structured report"): PersistedReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object in ${source}.`);
	const report = value as Record<string, unknown>;
	if (report.status !== "completed" && report.status !== "needs-input" && report.status !== "failed") throw new Error(`Invalid report status in ${source}.`);
	if (typeof report.summary !== "string" || !report.summary.trim()) throw new Error(`Missing report summary in ${source}.`);
	if (!Array.isArray(report.documents) || !report.documents.every((document) => {
		if (!document || typeof document !== "object" || Array.isArray(document)) return false;
		const entry = document as Record<string, unknown>;
		return typeof entry.path === "string" && typeof entry.description === "string";
	})) throw new Error(`Invalid report documents in ${source}.`);
	if (report.status === "needs-input" && (typeof report.question !== "string" || !report.question.trim())) throw new Error(`Missing report question in ${source}.`);
	if (report.error !== undefined && typeof report.error !== "string") throw new Error(`Invalid report error in ${source}.`);
	if (report.question !== undefined && typeof report.question !== "string") throw new Error(`Invalid report question in ${source}.`);
	if (report.failureKind !== undefined && report.failureKind !== "missing_input") throw new Error(`Invalid report failureKind in ${source}.`);
	if (report.requiredInput !== undefined && (typeof report.requiredInput !== "string" || !report.requiredInput.trim())) throw new Error(`Invalid report requiredInput in ${source}.`);
	if (report.failureKind === "missing_input" && report.status !== "failed") throw new Error(`missing_input must be a failed report in ${source}.`);
	if (report.failureKind === "missing_input" && (typeof report.requiredInput !== "string" || !report.requiredInput.trim())) throw new Error(`Missing report requiredInput in ${source}.`);
	if (report.attemptId !== undefined && (typeof report.attemptId !== "string" || !report.attemptId.trim())) throw new Error(`Invalid report attemptId in ${source}.`);
	return report as unknown as PersistedReport;
}

export async function readReport(path: string): Promise<PersistedReport> {
	return parseReport(await readObject(path), path);
}

export function normalizeNeedsInputReport(report: PersistedReport, effectiveConcurrency: number): PersistedReport {
	if (report.status !== "needs-input" || effectiveConcurrency <= 1) return report;
	return parseReport({
		...report,
		status: "failed",
		error: `Missing required input: ${report.question}`,
		failureKind: "missing_input",
		requiredInput: report.question,
		question: undefined,
	}, "normalized concurrent input request");
}

export async function persistFailureReport(path: string, report: PersistedReport, replaceExisting = false): Promise<string | undefined> {
	if (replaceExisting) {
		await writeJsonAtomic(path, parseReport(report, "generated failure report"));
		return undefined;
	}
	let archivedPath: string | undefined;
	if (existsSync(path)) {
		try { await readReport(path); return undefined; }
		catch {
			archivedPath = `${path}.invalid-${Date.now()}`;
			await rename(path, archivedPath);
		}
	}
	await writeJsonAtomic(path, parseReport(report, "generated failure report"));
	return archivedPath;
}

export function applyLifecycleStatus<T extends { status: string; question?: string; error?: string; updatedAt?: string; completedAt?: string }>(
	record: T,
	status: RunStatus,
	options: { question?: string; error?: string; at?: string } = {},
): T {
	const at = options.at ?? new Date().toISOString();
	delete record.question;
	delete record.error;
	delete record.updatedAt;
	delete record.completedAt;
	Object.assign(record, { status });
	if (status === "blocked") Object.assign(record, { updatedAt: at, ...(options.question ? { question: options.question } : {}) });
	else if (isActiveStatus(status)) Object.assign(record, { updatedAt: at });
	else Object.assign(record, { completedAt: at, ...(options.error ? { error: options.error } : {}) });
	return record;
}

export function applyTaskStatus<T extends TaskRecord | TurnRecord>(record: T, status: TaskStatus, options: { question?: string; error?: string; at?: string } = {}): T {
	const at = options.at ?? new Date().toISOString();
	if ("order" in record) {
		if (record.status === "running" && status !== "running") {
			const activeStarted = Date.parse(record.activeStartedAt ?? record.startedAt ?? "");
			const ended = Date.parse(at);
			if (Number.isFinite(activeStarted) && Number.isFinite(ended) && ended >= activeStarted) record.elapsedMs = Math.max(0, Number(record.elapsedMs ?? 0)) + (ended - activeStarted);
			delete record.activeStartedAt;
		} else if (status === "running" && record.status !== "running") {
			if (!(typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs))) {
				const frozenAt = record.status === "blocked" ? record.updatedAt : isSettledRunStatus(record.status) ? record.completedAt : undefined;
				const started = Date.parse(record.startedAt ?? "");
				const ended = Date.parse(frozenAt ?? "");
				if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) record.elapsedMs = ended - started;
			}
			record.startedAt ??= at;
			record.activeStartedAt = at;
		}
	}
	return applyLifecycleStatus(record, status, { ...options, at });
}

export async function settleAttemptFailure<T extends TaskRecord | TurnRecord>(
	record: T,
	reportPath: string,
	options: { cancelled: boolean; error: string; name: string; summary?: string; at?: string; replaceReport?: boolean },
): Promise<{ status: "cancelled" | "failed"; report: PersistedReport }> {
	const status = options.cancelled ? "cancelled" : "failed";
	const at = options.at ?? new Date().toISOString();
	applyTaskStatus(record, status, { error: options.error, at });
	const report: PersistedReport = {
		status: "failed",
		summary: options.summary ?? `${options.name} ${options.cancelled ? "was cancelled" : "failed"}.`,
		documents: [],
		error: options.error,
		reportedAt: at,
	};
	await persistFailureReport(reportPath, report, options.replaceReport);
	return { status, report };
}

export function applyReport(record: TaskRecord | TurnRecord, report: PersistedReport, completedAt = new Date().toISOString()): "blocked" | "completed" | "failed" {
	const status = report.status === "needs-input" ? "blocked" : report.status;
	applyTaskStatus(record, status, { at: completedAt, question: report.question, error: report.error });
	if ("order" in record) {
		if (report.failureKind) record.failureKind = report.failureKind;
		else delete record.failureKind;
		if (report.requiredInput) record.requiredInput = report.requiredInput;
		else delete record.requiredInput;
	}
	return status;
}
