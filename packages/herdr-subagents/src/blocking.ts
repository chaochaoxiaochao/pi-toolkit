import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import { continueQueuedRun } from "./continue-run.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, isActiveStatus, persistFailureReport, projectTaskActivity, readReport, readRunRecord, readTaskRecord, readTurnRecord, settleAttemptFailure, type PersistedDocument, type PersistedReport, type RunRecord, type TaskActivity, type TaskRecord, type TaskStatus, type TurnRecord } from "./records.ts";
import { isAbortError } from "./errors.ts";
import { continuationSystemPrompt } from "./protocol.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";
import { findRunDirectory } from "./run-locator.ts";
import { acquireDirectoryLock, withRunStateLock } from "./run-state.ts";
import { createAttemptId } from "./attempts.ts";
import { aggregateTasksWithResume, claimResumeCleanup } from "./resume-state.ts";

export interface RespondToBlockedTaskOptions { herdr?: HerdrAutomation; taskNumber: number; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; onWarning?: (message: string) => void; onStalled?: (message: string) => void; onUpdate?: (result: ResumeBlockedResult) => void; }
export interface ResumeBlockedResult {
	ok: boolean;
	runId: string;
	label: string;
	status: "running" | "blocked" | "completed" | "partial" | "failed" | "cancelled";
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

/**
 * A blocked task still owns a live child waiting for an answer. A settled failed task can only
 * continue from its saved Pi session.
 */
function isContinuable(task: TaskRecord, taskNumber: number): boolean {
	if (task.order !== taskNumber) return false;
	if (task.status === "blocked") return true;
	return task.status === "failed" && existsSync(task.sessionFile ?? "");
}

function noContinuableTaskError(runId: string, taskNumber: number): Error {
	return new Error(`Run '${runId}' task ${taskNumber} is neither blocked nor a failed task with a saved Pi session.`);
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
	const settledState = await withRunStateLock(runFile, undefined, async (latest) => {
		const tasks = await Promise.all(taskDirectories.map((directory) => readTaskRecord(join(directory, "task.json"))));
		if (latest.resume) {
			for (const task of tasks) {
				const member = latest.resume.active[task.id];
				if (!member || member.attemptId !== task.currentAttemptId) continue;
				if (task.status === "blocked") member.phase = "blocked";
				else if (!isActiveStatus(task.status)) delete latest.resume.active[task.id];
			}
		}
		const aggregated = aggregateTasksWithResume(tasks, latest.resume?.active);
		const blockedTask = tasks.find((task) => task.status === "blocked");
		// Queued work aggregates as blocked; with no blocked task the run is simply still running.
		const status = aggregated === "blocked" && !blockedTask ? "running" : aggregated;
		applyRunStatus(latest, status, { question: blockedTask?.question });
		const cleanup = status === "running" || status === "blocked" ? undefined : claimResumeCleanup(latest)
			?? (!latest.resume && latest.tabId ? { tabId: latest.tabId, generation: undefined } : undefined);
		return { run: latest, tasks, status, cleanup };
	});
	let finalTasks = settledState.tasks;
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
	const runStatus = settledState.status;
	const blockedIndex = finalTasks.findIndex((entry) => entry.status === "blocked");
	const blockedReport = blockedIndex >= 0 ? finalReports[blockedIndex] : undefined;
	run = settledState.run;
	if (settledState.cleanup) await cleanupRunTab({
		herdr, tabId: settledState.cleanup.tabId, runFile, runRecord: run, onError: onCleanupError,
		onClosed: (latest) => {
			if (settledState.cleanup?.generation !== undefined && latest.resume?.generation === settledState.cleanup.generation && latest.resume.phase === "closing") delete latest.resume;
		},
	});
	const summary = runStatus === "completed" ? "All tasks completed after the answer." : runStatus === "running" ? "Other resumed tasks are still running." : runStatus === "blocked" ? `${finalTasks[blockedIndex]?.name ?? "Task"} needs input: ${blockedReport?.question ?? "Input required."}` : finalReports.map((entry, index) => `${finalTasks[index].name}: ${entry.summary}`).join("\n");
	const activity = finalTasks.map((entry, index) => projectTaskActivity(entry, index));
	const tasks = finalTasks.map((entry, index) => ({ index, name: activity[index].name, status: entry.status, summary: String(finalReports[index].summary ?? "Task has no report."), documents: finalReports[index].documents ?? [], ...(entry.error ? { error: String(entry.error) } : {}), ...(entry.question ? { question: String(entry.question) } : {}), paneId: String(entry.paneId ?? ""), recordDirectory: taskDirectories[index], sessionFile: String(entry.sessionFile ?? "") }));
	return { ok: runStatus === "completed", runId: run.id, label: String(run.label ?? "batch"), status: runStatus, summary, ...(blockedReport?.question ? { question: blockedReport.question } : {}), documents: finalReports.flatMap((entry) => entry.documents ?? []), recordDirectory: runDirectory, requestedConcurrency: Number(run.requestedConcurrency ?? run.effectiveConcurrency ?? 1), effectiveConcurrency: Number(run.effectiveConcurrency ?? 1), tasks, activity, ...(run.tabId ? { tabId: String(run.tabId) } : {}) };
}

export async function respondToBlockedTask(cwd: string, runId: string, answer: string, options: RespondToBlockedTaskOptions = {}): Promise<ResumeBlockedResult> {
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	const runDirectory = await findRunDirectory(runsDirectory, runId);
	if (!runDirectory) throw new Error(`Unknown Subagent run '${runId}'.`);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	let blockedTaskDirectory: string | undefined;
	for (const directory of taskDirectories) {
		const task = await readTaskRecord(join(directory, "task.json"));
		if (isContinuable(task, options.taskNumber)) { blockedTaskDirectory = directory; break; }
	}
	if (!blockedTaskDirectory) throw noContinuableTaskError(runId, options.taskNumber);
	const taskLock = await acquireDirectoryLock(join(blockedTaskDirectory, ".resume.lock"), {
		wait: false,
		signal: options.signal,
		contentionMessage: `Run '${runId}' already has a response or resume in progress for that task.`,
	});
	try { return await respondToBlockedTaskLocked(cwd, runId, answer, runDirectory, options); }
	finally { await taskLock.release(); }
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
		if (isContinuable(candidate, taskNumber)) { taskDirectory = directory; task = candidate; break; }
	}
	if (!taskDirectory || !task) throw noContinuableTaskError(runId, taskNumber);
	Object.assign(run, ownerRecord(options.owner));
	const respondingToBlocked = task.status === "blocked";
	const historicalResume = Boolean(run.resume?.active[task.id]);
	const responseAttemptId = createAttemptId();
	const previousReport = await readReport(join(taskDirectory, "report.json"));
	const turnsDirectory = join(taskDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const resumePrompt = join(taskDirectory, "resume-system-prompt.md");
	await writeTextAtomic(resumePrompt, `${continuationSystemPrompt(task.systemPrompt, "Continue from the supplied answer.", "resumed")}\n`);
	const taskFile = join(taskDirectory, "task.json");
	const claimedFrom: TaskRecord = structuredClone(task);
	// Claim the task before any pane work. A settling batch or a sibling continuation decides tab
	// cleanup from the task records it reads under this lock, so an unclaimed continuation can have
	// the tab it is about to use closed underneath it.
	applyTaskStatus(task, "running");
	await withRunStateLock(runFile, signal, async (latest) => {
		await writeJsonAtomic(taskFile, task);
		Object.assign(latest, ownerRecord(options.owner));
		applyRunStatus(latest, "running");
	});
	let paneId = String(task.paneId ?? "");
	let agentName = String(task.agentName ?? liveAgentName(task.id));
	let live = false;
	try {
		live = Boolean(paneId) && await herdr.paneExists(paneId, signal) && await herdr.isTaskRunning(paneId, signal);
		if (!live) {
			const paneAllocator = new RunPaneAllocator({ herdr, run, runFile, signal, validateExistingPane: true, onCleanupError });
			paneId = await paneAllocator.allocate(taskDirectory);
			agentName = liveAgentName(task.id, Number(task.attempt ?? 1) + 1);
			task.attempt = Number(task.attempt ?? 1) + 1;
			await herdr.renamePane(paneId, `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent}`, signal);
		}
	} catch (error) {
		// Nothing was prompted, so release the claim exactly instead of inventing a new outcome.
		await withRunStateLock(runFile, signal, async (latest) => {
			await writeJsonAtomic(taskFile, claimedFrom);
			const siblings = await Promise.all(taskDirectories.map((directory) => readTaskRecord(join(directory, "task.json"))));
			applyRunStatus(latest, aggregateTasksWithResume(siblings, latest.resume?.active), { question: claimedFrom.question });
		});
		throw error;
	}
	const attempt = Number(task.attempt ?? 1);
	const turnFile = live && task.currentTurnFile ? String(task.currentTurnFile) : join(turnsDirectory, `${String(attempt).padStart(2, "0")}.json`);
	let turn: TurnRecord = { attempt, prompt: task.prompt, status: task.status, summary: previousReport.summary, question: previousReport.question, documents: previousReport.documents ?? [], sessionFile: task.sessionFile, startedAt: task.startedAt };
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
	await Promise.all([
		writeJsonAtomic(join(taskDirectory, "task.json"), task),
		writeJsonAtomic(turnFile, turn),
		withRunStateLock(runFile, signal, (latest) => {
			Object.assign(latest, ownerRecord(options.owner));
			const member = latest.resume?.active[task.id];
			if (member) { member.attemptId = responseAttemptId; member.phase = "running"; }
		}),
	]);
	await emitProgress(options, runDirectory, run, taskDirectories, `${task.name ?? task.agent} is continuing after input.`);
	let report: PersistedReport;
	let status: "blocked" | "completed" | "failed" | "cancelled";
	let attemptError: unknown;
	try {
		const prompted = await promptLiveAgent({ herdr, task: { ...task, id: task.id, sessionFile: task.sessionFile }, paneId, prompt: answer, systemPromptFile: resumePrompt, agentName, attemptId: responseAttemptId, start: !live, signal, stalledWarningMs: run.stalledWarningSeconds ? Number(run.stalledWarningSeconds) * 1000 : undefined, onStalled: () => options.onStalled?.(`${task.name ?? task.agent} appears stalled; it is still running.`), onRuntimeUpdate: async (updated) => {
			Object.assign(task, updated);
			await emitProgress(options, runDirectory, run, taskDirectories, `${task.name ?? task.agent} runtime: ${updated.runtimeState}.`);
		} });
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
		applyTaskStatus(turn, "cancelled", { error: message });
		await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(turnFile, turn)]);
		return projectSettledRun(runDirectory, runFile, run, taskDirectories, herdr, onCleanupError);
	}
	turn.events.push({ type: "report", status, summary: report.summary, question: report.question, error: report.error, at: new Date().toISOString() });
	Object.assign(turn, { summary: report.summary, documents: report.documents ?? [] });
	applyReport(turn, report);
	await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(turnFile, turn)]);
	await emitProgress(options, runDirectory, run, taskDirectories, `${task.name ?? task.agent} ${status}.`);
	// Only a blocked task halts its batch worker. Continuing a settled failure must not restart
	// queued siblings that the still-running batch already owns.
	if (status !== "blocked" && !historicalResume && respondingToBlocked) {
		await continueQueuedRun(runDirectory, herdr, { cleanup: false, signal, onStalled: options.onStalled, onCleanupError, onUpdate: () => emitProgress(options, runDirectory, run, taskDirectories, "Queued tasks are continuing.") });
	}
	return projectSettledRun(runDirectory, runFile, run, taskDirectories, herdr, onCleanupError);
}
