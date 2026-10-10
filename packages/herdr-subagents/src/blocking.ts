import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import { continueQueuedRun } from "./continue-run.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { isProcessAlive, ownerRecord } from "./ownership.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, isActiveStatus, persistFailureReport, projectTaskActivity, readReport, readRunRecord, readTaskRecord, readTurnRecord, settleAttemptFailure, type PersistedDocument, type PersistedReport, type RunRecord, type TaskActivity, type TaskRecord, type TaskStatus, type TurnRecord } from "./records.ts";
import { isAbortError } from "./errors.ts";
import { continuationSystemPrompt } from "./protocol.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";
import { findRunDirectory } from "./run-locator.ts";

export interface RespondToBlockedTaskOptions { herdr?: HerdrAutomation; taskNumber?: number; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; onWarning?: (message: string) => void; onStalled?: (message: string) => void; onUpdate?: (result: ResumeBlockedResult) => void; }
export interface ResumeBlockedResult {
	ok: boolean;
	runId: string;
	label: string;
	status: "blocked" | "completed" | "partial" | "failed" | "cancelled";
	summary: string;
	question?: string;
	documents: PersistedDocument[];
	recordDirectory: string;
	requestedConcurrency: number;
	effectiveConcurrency: number;
	tasks?: Array<{ index: number; name: string; status: TaskStatus; summary: string; documents: PersistedDocument[]; error?: string; question?: string; paneId: string; recordDirectory: string; sessionFile: string }>;
	activity?: TaskActivity[];
	tabId?: string;
}

interface ResponseLock { token?: string; processId?: unknown; sessionId?: unknown; createdAt?: unknown; }

async function readResponseLock(lockFile: string): Promise<ResponseLock | undefined> {
	try {
		const lock = JSON.parse(await readFile(lockFile, "utf8")) as unknown;
		return lock && typeof lock === "object" ? lock as ResponseLock : undefined;
	} catch { return undefined; }
}

async function releaseResponseLock(lockFile: string, token: string): Promise<void> {
	if ((await readResponseLock(lockFile))?.token !== token) return;
	try { await unlink(lockFile); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function acquireResponseLock(lockFile: string, runId: string, owner?: OwnerIdentity): Promise<string> {
	const token = randomUUID();
	try {
		await writeFile(lockFile, `${JSON.stringify({ token, processId: process.pid, sessionId: owner?.sessionId, createdAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const lock = await readResponseLock(lockFile);
		if (lock && Number.isInteger(lock.processId) && !isProcessAlive(lock.processId)) {
			throw new Error(`Subagent run '${runId}' has a stale blocked-response lock from process ${lock.processId}; remove ${lockFile} and retry.`);
		}
		throw new Error(`Subagent run '${runId}' already has a blocked response in progress (lock: ${lockFile}).`);
	}
}

async function emitProgress(options: RespondToBlockedTaskOptions, runDirectory: string, run: RunRecord, taskDirectories: string[], summary: string): Promise<void> {
	if (!options.onUpdate) return;
	const tasks = await Promise.all(taskDirectories.map((directory) => readTaskRecord(join(directory, "task.json"))));
	options.onUpdate({
		ok: false,
		runId: run.id,
		label: run.label,
		status: "blocked",
		summary,
		documents: [],
		recordDirectory: runDirectory,
		requestedConcurrency: Number(run.requestedConcurrency ?? 1),
		effectiveConcurrency: Number(run.effectiveConcurrency ?? 1),
		activity: tasks.map((entry, index) => projectTaskActivity(entry, index)),
		...(run.tabId ? { tabId: run.tabId } : {}),
	});
}

async function projectSettledRun(runDirectory: string, runFile: string, run: RunRecord, taskDirectories: string[], herdr: HerdrAutomation, onCleanupError?: (message: string) => void): Promise<ResumeBlockedResult> {
	const finalTasks = await Promise.all(taskDirectories.map((directory) => readTaskRecord(join(directory, "task.json"))));
	const finalReports = await Promise.all(taskDirectories.map(async (directory, index) => {
		const reportFile = join(directory, "report.json");
		if (!existsSync(reportFile) && (finalTasks[index].status === "queued" || finalTasks[index].status === "cancelled")) return { status: "failed" as const, summary: finalTasks[index].error ?? (finalTasks[index].status === "queued" ? "Task is still queued." : "Task was cancelled."), documents: [] };
		try { return await readReport(reportFile); }
		catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const failedReport = { status: "failed" as const, summary: `Could not read task report: ${detail}`, documents: [], error: detail };
			applyReport(finalTasks[index], failedReport);
			await Promise.all([writeJsonAtomic(join(directory, "task.json"), finalTasks[index]), persistFailureReport(reportFile, failedReport)]);
			return failedReport;
		}
	}));
	const aggregateStatus = aggregateTaskStatus(finalTasks.map((entry) => entry.status));
	const runStatus = aggregateStatus === "running" ? "blocked" : aggregateStatus;
	const blockedIndex = finalTasks.findIndex((entry) => entry.status === "blocked");
	const blockedReport = blockedIndex >= 0 ? finalReports[blockedIndex] : undefined;
	run = await readRunRecord(runFile);
	applyRunStatus(run, runStatus, { question: blockedReport?.question });
	await writeJsonAtomic(runFile, run);
	if (runStatus !== "blocked" && run.tabId) await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, onError: onCleanupError });
	const summary = runStatus === "completed" ? "All tasks completed after the answer." : runStatus === "blocked" ? `${finalTasks[blockedIndex]?.name ?? "Task"} needs input: ${blockedReport?.question ?? "Input required."}` : finalReports.map((entry, index) => `${finalTasks[index].name}: ${entry.summary}`).join("\n");
	const activity = finalTasks.map((entry, index) => projectTaskActivity(entry, index));
	const tasks = finalTasks.map((entry, index) => ({ index, name: activity[index].name, status: entry.status, summary: String(finalReports[index].summary ?? "Task has no report."), documents: finalReports[index].documents ?? [], ...(entry.error ? { error: String(entry.error) } : {}), ...(entry.question ? { question: String(entry.question) } : {}), paneId: String(entry.paneId ?? ""), recordDirectory: taskDirectories[index], sessionFile: String(entry.sessionFile ?? "") }));
	return { ok: runStatus === "completed", runId: run.id, label: String(run.label ?? "batch"), status: runStatus, summary, ...(blockedReport?.question ? { question: blockedReport.question } : {}), documents: finalReports.flatMap((entry) => entry.documents ?? []), recordDirectory: runDirectory, requestedConcurrency: Number(run.requestedConcurrency ?? run.effectiveConcurrency ?? 1), effectiveConcurrency: Number(run.effectiveConcurrency ?? 1), tasks, activity, ...(run.tabId ? { tabId: String(run.tabId) } : {}) };
}

export async function respondToBlockedTask(cwd: string, runId: string, answer: string, options: RespondToBlockedTaskOptions = {}): Promise<ResumeBlockedResult> {
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	const runDirectory = await findRunDirectory(runsDirectory, runId);
	if (!runDirectory) throw new Error(`Unknown Subagent run '${runId}'.`);
	const lockFile = join(runDirectory, ".respond.lock");
	const lockToken = await acquireResponseLock(lockFile, runId, options.owner);
	try { return await respondToBlockedTaskLocked(cwd, runId, answer, runDirectory, options); }
	finally { await releaseResponseLock(lockFile, lockToken); }
}

async function respondToBlockedTaskLocked(cwd: string, runId: string, answer: string, runDirectory: string, options: RespondToBlockedTaskOptions): Promise<ResumeBlockedResult> {
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const { taskNumber, signal, onCleanupError } = options;
	const runFile = join(runDirectory, "run.json");
	const run = await readRunRecord(runFile);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	let taskDirectory: string | undefined;
	let task: TaskRecord | undefined;
	for (const directory of taskDirectories) {
		const candidate = await readTaskRecord(join(directory, "task.json"));
		if (candidate.status === "blocked" && (!taskNumber || candidate.order === taskNumber)) { taskDirectory = directory; task = candidate; break; }
	}
	if (!taskDirectory || !task) throw new Error(`Run '${runId}' has no blocked task.`);
	Object.assign(run, ownerRecord(options.owner));
	const previousReport = await readReport(join(taskDirectory, "report.json"));
	const turnsDirectory = join(taskDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const resumePrompt = join(taskDirectory, "resume-system-prompt.md");
	await writeTextAtomic(resumePrompt, `${continuationSystemPrompt(task.systemPrompt, "Continue from the supplied answer.", "resumed")}\n`);
	let paneId = String(task.paneId ?? "");
	let agentName = String(task.agentName ?? liveAgentName(task.id));
	let live = Boolean(paneId) && await herdr.paneExists(paneId, signal) && await herdr.isTaskRunning(paneId, signal);
	if (!live) {
		const paneAllocator = new RunPaneAllocator({ herdr, run, runFile, signal, validateExistingPane: true, onCleanupError });
		paneId = await paneAllocator.allocate(taskDirectory);
		agentName = liveAgentName(task.id, Number(task.attempt ?? 1) + 1);
		task.attempt = Number(task.attempt ?? 1) + 1;
		await herdr.renamePane(paneId, `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent}`, signal);
	}
	const attempt = Number(task.attempt ?? 1);
	const turnFile = live && task.currentTurnFile ? String(task.currentTurnFile) : join(turnsDirectory, `${String(attempt).padStart(2, "0")}.json`);
	let turn: TurnRecord = { attempt, prompt: task.prompt, status: "blocked", summary: previousReport.summary, question: previousReport.question, documents: previousReport.documents ?? [], sessionFile: task.sessionFile, startedAt: task.startedAt };
	if (existsSync(turnFile)) {
		try { turn = await readTurnRecord(turnFile); }
		catch (error) {
			const archivedPath = `${turnFile}.invalid-${Date.now()}`;
			await rename(turnFile, archivedPath);
			options.onWarning?.(`Archived invalid durable turn ${turnFile} at ${archivedPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	turn.events = [...(Array.isArray(turn.events) ? turn.events : []), { type: "answer", text: answer, at: new Date().toISOString() }];
	task.currentTurnFile = turnFile;
	applyTaskStatus(task, "running");
	Object.assign(task, { tabId: run.tabId, paneId, agentName });
	await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(runFile, run), writeJsonAtomic(turnFile, turn)]);
	await emitProgress(options, runDirectory, run, taskDirectories, `${task.name ?? task.agent} is continuing after input.`);
	let report: PersistedReport;
	let status: "blocked" | "completed" | "failed" | "cancelled";
	let attemptError: unknown;
	try {
		const prompted = await promptLiveAgent({ herdr, task: { ...task, id: task.id, sessionFile: task.sessionFile }, paneId, prompt: answer, systemPromptFile: resumePrompt, agentName, start: !live, signal, stalledWarningMs: run.stalledWarningSeconds ? Number(run.stalledWarningSeconds) * 1000 : undefined, onStalled: () => options.onStalled?.(`${task.name ?? task.agent} appears stalled; it is still running.`) });
		task.currentAttemptId = prompted.attemptId;
		report = prompted.report;
		status = applyReport(task, report);
	} catch (error) {
		attemptError = error;
		const settled = await settleAttemptFailure(task, join(taskDirectory, "report.json"), {
			cancelled: isAbortError(error, signal),
			error: error instanceof Error ? error.message : String(error),
			name: `${task.name ?? task.agent} response`,
			replaceReport: true,
		});
		report = settled.report;
		status = settled.status;
	}
	if (attemptError && isAbortError(attemptError, signal)) {
		const message = attemptError instanceof Error ? attemptError.message : String(attemptError);
			applyTaskStatus(task, "cancelled", { error: message });
			applyRunStatus(run, "cancelled", { error: message });
			applyTaskStatus(turn, "cancelled", { error: message });
			for (const siblingDirectory of taskDirectories) {
				if (siblingDirectory === taskDirectory) continue;
				const siblingFile = join(siblingDirectory, "task.json");
				const sibling = await readTaskRecord(siblingFile);
				if (!isActiveStatus(sibling.status)) continue;
				applyTaskStatus(sibling, "cancelled", { error: "Parent Pi session closed." });
				await writeJsonAtomic(siblingFile, sibling);
			}
			await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(runFile, run), writeJsonAtomic(turnFile, turn)]);
			if (run.tabId) await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, signal, onError: onCleanupError });
			return { ok: false, runId, label: String(run.label ?? "batch"), status: "cancelled", summary: "Subagent response cancelled.", documents: [], recordDirectory: runDirectory, requestedConcurrency: Number(run.requestedConcurrency ?? 1), effectiveConcurrency: Number(run.effectiveConcurrency ?? 1), ...(run.tabId ? { tabId: String(run.tabId) } : {}) };
	}
	turn.events.push({ type: "report", status, summary: report.summary, question: report.question, error: report.error, at: new Date().toISOString() });
	Object.assign(turn, { summary: report.summary, documents: report.documents ?? [] });
	applyReport(turn, report);
	await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(turnFile, turn)]);
	await emitProgress(options, runDirectory, run, taskDirectories, `${task.name ?? task.agent} ${status}.`);
	if (status !== "blocked") {
		applyRunStatus(run, "queued");
		await writeJsonAtomic(runFile, run);
		await continueQueuedRun(runDirectory, herdr, { cleanup: false, signal, onStalled: options.onStalled, onCleanupError, onUpdate: () => emitProgress(options, runDirectory, run, taskDirectories, "Queued tasks are continuing.") });
	}
	return projectSettledRun(runDirectory, runFile, run, taskDirectories, herdr, onCleanupError);
}
