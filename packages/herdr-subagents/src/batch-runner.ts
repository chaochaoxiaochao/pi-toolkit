import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import type { PersonaAccess } from "./config.ts";
import type { HerdrSubagentsDocument } from "./runner.ts";
import { ensureRuntimeIgnored } from "./history.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";
import { applyReport, applyTaskStatus, normalizeNeedsInputReport, projectTaskActivity, settleAttemptFailure, type PersistedReport, type RunRecord, type TaskActivity, type TaskRecord, type TaskStatus } from "./records.ts";
import { reportProtocolPrompt } from "./protocol.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
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
	documents: HerdrSubagentsDocument[];
	error?: string;
	question?: string;
	failureKind?: "missing_input";
	requiredInput?: string;
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
	documents: HerdrSubagentsDocument[];
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
	const effectiveConcurrency = tasks.some((task) => task.access === "write") ? 1 : Math.min(requestedConcurrency, options.maxConcurrency, tasks.length);
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
			tools: task.tools, skills: task.skills, systemPrompt: reportProtocolPrompt(task.systemPrompt), sessionFile,
		};
		await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
		await writeFile(systemPromptFile, String(taskRecord.systemPrompt), { encoding: "utf8", mode: 0o600 });
		const taskFile = join(taskDirectory, "task.json");
		await writeJsonAtomic(taskFile, taskRecord);
		return { taskId, taskDirectory, sessionFile, reportFile: join(taskDirectory, "report.json"), taskFile, systemPromptFile, taskRecord };
	}));
	const runRecord: RunRecord = {
		id: runId, label: options.label, status: "starting", cwd: options.cwd, ...ownerRecord(options.owner), requestedConcurrency,
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

	emit("starting", `Starting up to ${effectiveConcurrency} interactive Pi Agent${effectiveConcurrency === 1 ? "" : "s"}...`);
	let nextIndex = 0;
	let settled = 0;
	try {
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
				const prompted = await promptLiveAgent({ herdr, task: { ...task, id: context.taskId, sessionFile: context.sessionFile }, paneId, prompt: task.prompt, systemPromptFile: context.systemPromptFile, agentName, signal: options.signal, stalledWarningMs: options.stalledWarningSeconds ? options.stalledWarningSeconds * 1000 : undefined, onStalled: () => emit("running", `${task.name} appears stalled; it is still running.`) });
				agentName = prompted.agentName;
				context.taskRecord.currentAttemptId = prompted.attemptId;
				report = normalizeNeedsInputReport(prompted.report, effectiveConcurrency);
				if (report !== prompted.report) await Promise.all([writeJsonAtomic(context.reportFile, report), writeJsonAtomic(attemptReportPath(context.taskDirectory, prompted.attemptId), report)]);
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
			results[index] = { index, name: task.name, status, summary: report.summary, documents: report.documents, ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}), ...(report.failureKind ? { failureKind: report.failureKind } : {}), ...(report.requiredInput ? { requiredInput: report.requiredInput } : {}), paneId, recordDirectory: context.taskDirectory, sessionFile: context.sessionFile };
			activity[index] = projectTaskActivity(context.taskRecord, index);
			settled += 1;
			emit("running", `${settled}/${tasks.length} tasks settled.`);
		};
		const worker = async () => {
			while (!options.signal?.aborted) {
				const index = nextIndex++;
				if (index >= tasks.length) return;
				await runOne(index);
				if (results[index]?.status === "blocked") return;
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
		const settledResults = results.filter(Boolean);
		const blocked = settledResults.find((result) => result.status === "blocked");
		const failed = settledResults.filter((result) => result.status === "failed").length;
		const completed = settledResults.filter((result) => result.status === "completed").length;
		const cancelled = settledResults.filter((result) => result.status === "cancelled").length;
		const status = aggregateTaskStatus(activity.map((entry) => entry.status)) as BatchResult["status"];
		const summary = status === "cancelled" ? "Subagent batch cancelled." : blocked ? `${blocked.name} needs input: ${blocked.question}` : status === "partial" ? `${completed}/${tasks.length} tasks completed; ${failed} failed; ${cancelled} cancelled.` : failed ? `${completed}/${tasks.length} tasks completed; ${failed} failed.` : `${tasks.length}/${tasks.length} tasks completed.`;
		applyRunStatus(runRecord, status, { question: blocked?.question });
		await writeJsonAtomic(runFile, runRecord);
		return { ok: status === "completed", status, runId, label: options.label, requestedConcurrency, effectiveConcurrency, tasks: settledResults, activity, summary, documents: settledResults.flatMap((result) => result.documents), recordDirectory: runDirectory, tabId, ...(blocked?.question ? { question: blocked.question, allowedActions: ["respond", "cancel"] } : {}) };
	} catch (error) {
		applyRunStatus(runRecord, options.signal?.aborted ? "cancelled" : "failed", { error: error instanceof Error ? error.message : String(error) });
		await writeJsonAtomic(runFile, runRecord);
		throw error;
	} finally {
		const keepTab = !options.signal?.aborted && activity.some((entry) => entry.status === "blocked" || entry.status === "queued" || entry.status === "running");
		if (tabId && !keepTab) {
			await cleanupRunTab({
				herdr, tabId, runFile, runRecord, signal: options.signal,
				errorPrefix: "Task results settled, but Herdr tab cleanup failed",
				onError: (message) => options.onCleanupError?.(message),
			});
		}
	}
}
