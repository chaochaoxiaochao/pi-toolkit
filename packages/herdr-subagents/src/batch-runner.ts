import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import type { PersonaAccess } from "./config.ts";
import { ensureRuntimeIgnored } from "./history.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";
import { applyReport, applyTaskStatus, isActiveStatus, projectTaskActivity, readReport, readTaskRecord, settleAttemptFailure, type PersistedDocument, type PersistedReport, type RunRecord, type RunStatus, type TaskActivity, type TaskRecord, type TaskStatus } from "./records.ts";
import { reportProtocolPrompt } from "./protocol.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { acquireDirectoryLock, adoptRecord, queueLockPath, withRunStateLock, type DirectoryLock } from "./run-state.ts";
import { aggregateTasksWithResume, readTaskEntries } from "./resume-state.ts";
import { isAbortError } from "./errors.ts";
import { attemptReportPath } from "./attempts.ts";

export interface BatchTask {
	name: string;
	prompt: string;
	agent: string;
	access: PersonaAccess;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills: string[];
	extensions?: string[];
	systemPrompt: string;
}

export interface BatchOptions {
	runId?: string;
	label: string;
	concurrency: number;
	maxConcurrency: number;
	stalledWarningSeconds?: number;
	cwd: string;
	signal?: AbortSignal;
	herdr?: HerdrAutomation;
	owner?: OwnerIdentity;
	onUpdate?: (result: BatchResult) => void;
	onCleanupError?: (message: string) => void;
}

type BatchTaskStatus = Exclude<TaskStatus, "starting">;
export interface BatchTaskResult {
	index: number;
	name: string;
	status: Exclude<BatchTaskStatus, "queued" | "running">;
	summary: string;
	documents: PersistedDocument[];
	error?: string;
	question?: string;
	paneId: string;
	recordDirectory: string;
	sessionFile: string;
}
export interface BatchResult {
	ok: boolean;
	status: "starting" | "running" | "blocked" | "completed" | "partial" | "failed" | "cancelled";
	runId: string;
	label: string;
	requestedConcurrency: number;
	effectiveConcurrency: number;
	tasks: BatchTaskResult[];
	activity: TaskActivity[];
	summary: string;
	documents: PersistedDocument[];
	recordDirectory: string;
	tabId?: string;
	question?: string;
	allowedActions?: Array<"respond" | "cancel">;
}

type TaskContext = {
	taskId: string;
	taskDirectory: string;
	sessionFile: string;
	reportFile: string;
	taskFile: string;
	systemPromptFile: string;
	taskRecord: TaskRecord;
};

function timestamp(): string { return new Date().toISOString(); }
export async function runHerdrSubagentsBatch(tasks: BatchTask[], options: BatchOptions): Promise<BatchResult> {
	if (!tasks.length) throw new Error("At least one task is required.");
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new Error("Herdr Subagents must run from a Pi session inside Herdr.");
	const runId = options.runId ?? randomUUID();
	const requestedConcurrency = Math.max(1, Math.floor(options.concurrency));
	if (requestedConcurrency > 1 && tasks.some((task) => task.access === "write")) {
		const writers = tasks.filter((task) => task.access === "write").map((task) => `${JSON.stringify(task.name)} (agent=${task.agent})`).join(", ");
		throw new Error(`Write-capable tasks require concurrency 1: ${writers}. Use concurrency: 1, or select a read-only Persona for read-only work.`);
	}
	const effectiveConcurrency = Math.min(requestedConcurrency, options.maxConcurrency, tasks.length);
	const runDirectory = join(options.cwd, ".pi", "herdr-subagents", "runs", `${timestamp().replace(/[-:.]/g, "").replace("Z", "Z-")}${runId.slice(0, 8)}`);
	const runFile = join(runDirectory, "run.json");
	await ensureRuntimeIgnored(options.cwd);
	await mkdir(join(runDirectory, "tasks"), { recursive: true, mode: 0o700 });
	const contexts: TaskContext[] = await Promise.all(tasks.map(async (task, index) => {
		const taskId = randomUUID();
		const taskDirectory = join(runDirectory, "tasks", `${String(index + 1).padStart(2, "0")}-${taskId.slice(0, 8)}`);
		const sessionFile = join(taskDirectory, "session.jsonl");
		const systemPromptFile = join(taskDirectory, "system-prompt.md");
		const taskRecord: TaskRecord = {
			id: taskId, runId, order: index + 1, name: task.name, status: "queued", prompt: task.prompt,
			agent: task.agent, access: task.access, model: task.model, thinking: task.thinking,
			tools: task.tools, skills: task.skills, extensions: task.extensions, systemPrompt: reportProtocolPrompt(task.systemPrompt), sessionFile,
		};
		await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
		await writeFile(systemPromptFile, String(taskRecord.systemPrompt), { encoding: "utf8", mode: 0o600 });
		const taskFile = join(taskDirectory, "task.json");
		await writeJsonAtomic(taskFile, taskRecord);
		return { taskId, taskDirectory, sessionFile, reportFile: join(taskDirectory, "report.json"), taskFile, systemPromptFile, taskRecord };
	}));
	const runRecord: RunRecord = {
		id: runId, label: options.label, status: "running", cwd: options.cwd, ...ownerRecord(options.owner), requestedConcurrency,
		effectiveConcurrency, stalledWarningSeconds: options.stalledWarningSeconds, startedAt: timestamp(), taskIds: contexts.map((context) => context.taskId), paneIds: [],
	};
	await writeJsonAtomic(runFile, runRecord);
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const results = new Array<BatchTaskResult>(tasks.length);
	const activity: BatchResult["activity"] = contexts.map((context, index) => projectTaskActivity(context.taskRecord, index));
	let tabId: string | undefined;
	const paneAllocator = new RunPaneAllocator({ herdr, run: runRecord, runFile, signal: options.signal, onCleanupError: options.onCleanupError });
	const emit = (status: BatchResult["status"], summary: string) => options.onUpdate?.({
		ok: false, status, runId, label: options.label, requestedConcurrency, effectiveConcurrency,
		tasks: results.filter(Boolean), activity: activity.map((entry) => ({ ...entry })), summary,
		documents: results.filter(Boolean).flatMap((result) => result.documents), recordDirectory: runDirectory, tabId,
	});
	const allocatePane = async (index: number): Promise<string> => {
		const paneId = await paneAllocator.allocate(contexts[index].taskDirectory);
		tabId = paneAllocator.tabId;
		return paneId;
	};
	// Settling the run must not be cancellable, so the terminal status is never written under options.signal.
	let settledAggregate: RunStatus | undefined;
	const persistRunStatus = async (status: BatchResult["status"], lifecycle: { question?: string; error?: string }, force = false) => {
		settledAggregate = await withRunStateLock(runFile, undefined, async (run) => {
			let effective: RunStatus = status;
			try {
				// Task records are more current than this batch's own view once a follow-up continues a
				// settled task. A thrown batch still forces its outcome, but never over live work.
				const observed = aggregateTasksWithResume((await readTaskEntries(runDirectory)).map((entry) => entry.task), run.resume?.active);
				if (!force || isActiveStatus(observed)) effective = observed;
			} catch (error) {
				options.onCleanupError?.(`Could not inspect task records while settling the run; used this batch's own view: ${error instanceof Error ? error.message : String(error)}`);
			}
			applyRunStatus(run, effective, lifecycle);
			adoptRecord(runRecord, run);
			return effective;
		});
	};

	emit("starting", `Starting up to ${effectiveConcurrency} interactive Pi Agent${effectiveConcurrency === 1 ? "" : "s"}...`);
	let nextIndex = 0;
	let settled = 0;
	let queueLock: DirectoryLock | undefined;
	try {
		// One batch lane blocking does not stop the others, so this batch keeps starting queued tasks.
		// Holding the queue lock for its whole life keeps a concurrent response from starting them too.
		queueLock = await acquireDirectoryLock(queueLockPath(runDirectory), { wait: false });
		const runOne = async (index: number): Promise<void> => {
			const task = tasks[index];
			const context = contexts[index];
			let paneId = "";
			let agentName = liveAgentName(context.taskId);
			let report: PersistedReport;
			let status: BatchTaskResult["status"];
			try {
				paneId = await allocatePane(index);
				const paneLabel = `${String(index + 1).padStart(2, "0")} · ${task.name}`;
				await herdr.renamePane(paneId, paneLabel, options.signal);
				applyTaskStatus(context.taskRecord, "running");
				Object.assign(context.taskRecord, { tabId, paneId, paneLabel, agentName, startedAt: timestamp() });
				await writeJsonAtomic(context.taskFile, context.taskRecord);
				activity[index] = projectTaskActivity(context.taskRecord, index);
				emit("running", `${settled}/${tasks.length} tasks settled.`);
				const prompted = await promptLiveAgent({ herdr, task: { ...task, id: context.taskId, sessionFile: context.sessionFile }, paneId, prompt: task.prompt, systemPromptFile: context.systemPromptFile, agentName, signal: options.signal, stalledWarningMs: options.stalledWarningSeconds ? options.stalledWarningSeconds * 1000 : undefined, onStalled: () => emit("running", `${task.name} appears stalled; it is still running.`), onRuntimeUpdate: (updated) => {
					Object.assign(context.taskRecord, updated);
					activity[index] = projectTaskActivity(context.taskRecord, index);
					emit("running", `${settled}/${tasks.length} tasks settled.`);
				} });
				agentName = prompted.agentName;
				context.taskRecord.currentAttemptId = prompted.attemptId;
				report = prompted.report;
				status = applyReport(context.taskRecord, report);
			} catch (error) {
				const settled = await settleAttemptFailure(context.taskRecord, context.reportFile, {
					cancelled: isAbortError(error, options.signal),
					error: error instanceof Error ? error.message : String(error),
					name: task.name,
				});
				report = settled.report;
				status = settled.status;
			}
			Object.assign(context.taskRecord, { paneId, agentName });
			await writeJsonAtomic(context.taskFile, context.taskRecord);
			results[index] = { index, name: task.name, status, summary: report.summary, documents: report.documents, ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}), paneId, recordDirectory: context.taskDirectory, sessionFile: context.sessionFile };
			activity[index] = projectTaskActivity(context.taskRecord, index);
			settled += 1;
			emit("running", `${settled}/${tasks.length} tasks settled.`);
		};
		const worker = async () => {
			while (!options.signal?.aborted) {
				const index = nextIndex++;
				if (index >= tasks.length) return;
				await runOne(index);
			}
		};
		const workers = await Promise.allSettled(Array.from({ length: effectiveConcurrency }, worker));
		const rejectedWorker = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
		if (rejectedWorker) throw rejectedWorker.reason;
		if (options.signal?.aborted) {
			for (let index = 0; index < tasks.length; index += 1) {
				if (activity[index].status !== "queued") continue;
				activity[index].status = "cancelled";
				Object.assign(contexts[index].taskRecord, { status: "cancelled", completedAt: timestamp(), error: "Parent Pi session closed." });
				await writeJsonAtomic(contexts[index].taskFile, contexts[index].taskRecord);
			}
		}
		// A response can settle a lane this batch left blocked while its independent siblings were still
		// running, so adopt the task records before reporting an outcome this batch no longer owns.
		for (let index = 0; index < results.length; index += 1) {
			if (results[index]?.status !== "blocked") continue;
			let latest: TaskRecord;
			let report: PersistedReport;
			try { [latest, report] = await Promise.all([readTaskRecord(contexts[index].taskFile), readReport(contexts[index].reportFile)]); }
			catch { continue; }
			if (latest.status === "blocked" || isActiveStatus(latest.status)) continue;
			adoptRecord(contexts[index].taskRecord, latest);
			activity[index] = projectTaskActivity(contexts[index].taskRecord, index);
			const previous = results[index];
			results[index] = {
				index: previous.index, name: previous.name, status: latest.status as BatchTaskResult["status"],
				summary: report.summary, documents: report.documents ?? [], ...(report.error ? { error: report.error } : {}),
				paneId: previous.paneId, recordDirectory: previous.recordDirectory, sessionFile: previous.sessionFile,
			};
		}
		const settledResults = results.filter(Boolean);
		const blocked = settledResults.find((result) => result.status === "blocked");
		const failed = settledResults.filter((result) => result.status === "failed").length;
		const completed = settledResults.filter((result) => result.status === "completed").length;
		const cancelled = settledResults.filter((result) => result.status === "cancelled").length;
		const status = aggregateTaskStatus(activity.map((entry) => entry.status)) as BatchResult["status"];
		const summary = status === "cancelled" ? "Subagent batch cancelled." : blocked ? `${blocked.name} needs input: ${blocked.question}` : status === "partial" ? `${completed}/${tasks.length} tasks completed; ${failed} failed; ${cancelled} cancelled.` : failed ? `${completed}/${tasks.length} tasks completed; ${failed} failed.` : `${tasks.length}/${tasks.length} tasks completed.`;
		await persistRunStatus(status, { question: blocked?.question });
		return { ok: status === "completed", status, runId, label: options.label, requestedConcurrency, effectiveConcurrency, tasks: settledResults, activity, summary, documents: settledResults.flatMap((result) => result.documents), recordDirectory: runDirectory, tabId, ...(blocked?.question ? { question: blocked.question, allowedActions: ["respond", "cancel"] } : {}) };
	} catch (error) {
		await persistRunStatus(options.signal?.aborted ? "cancelled" : "failed", { error: error instanceof Error ? error.message : String(error) }, true);
		throw error;
	} finally {
		await queueLock?.release();
		const keepTab = !options.signal?.aborted && (activity.some((entry) => entry.status === "blocked" || entry.status === "queued" || entry.status === "running") || (settledAggregate !== undefined && isActiveStatus(settledAggregate)));
		if (tabId && !keepTab) {
			await cleanupRunTab({
				herdr, tabId, runFile, runRecord, signal: options.signal,
				errorPrefix: "Task results settled, but Herdr tab cleanup failed",
				onError: (message) => options.onCleanupError?.(message),
			});
		}
	}
}
