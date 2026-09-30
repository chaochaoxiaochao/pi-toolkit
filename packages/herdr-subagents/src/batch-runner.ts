import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import type { PersonaAccess } from "./config.ts";
import type { HerdrSubagentsDocument, HerdrSubagentsReport } from "./runner.ts";
import { ensureRuntimeIgnored } from "./history.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";

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
}

export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export interface BatchTaskResult {
	index: number;
	name: string;
	status: Exclude<TaskStatus, "queued" | "running">;
	summary: string;
	documents: HerdrSubagentsDocument[];
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
	activity: Array<{ index: number; name: string; status: TaskStatus; paneId?: string }>;
	summary: string;
	documents: HerdrSubagentsDocument[];
	recordDirectory: string;
	tabId?: string;
}

type TaskContext = {
	taskId: string;
	taskDirectory: string;
	sessionFile: string;
	reportFile: string;
	taskFile: string;
	systemPromptFile: string;
	taskRecord: Record<string, unknown>;
};

function timestamp(): string { return new Date().toISOString(); }
function protocolPrompt(systemPrompt: string): string {
	return `${systemPrompt.trim()}\n\nWhen the task is finished, call subagent_report exactly once. Put the complete final answer in result, a concise parent-facing paragraph in summary, and list any useful document paths. Use status=needs-input with question when missing information prevents progress, or status=failed with an error when the task cannot be completed.`;
}
function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));
}

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
		const taskRecord: Record<string, unknown> = {
			id: taskId, runId, order: index + 1, name: task.name, status: "queued", prompt: task.prompt,
			agent: task.agent, access: task.access, model: task.model, thinking: task.thinking,
			tools: task.tools, skills: task.skills, systemPrompt: protocolPrompt(task.systemPrompt), sessionFile,
		};
		await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
		await writeFile(systemPromptFile, String(taskRecord.systemPrompt), { encoding: "utf8", mode: 0o600 });
		const taskFile = join(taskDirectory, "task.json");
		await writeJsonAtomic(taskFile, taskRecord);
		return { taskId, taskDirectory, sessionFile, reportFile: join(taskDirectory, "report.json"), taskFile, systemPromptFile, taskRecord };
	}));
	const runRecord: Record<string, unknown> = {
		id: runId, label: options.label, status: "starting", cwd: options.cwd, ...ownerRecord(options.owner), requestedConcurrency,
		effectiveConcurrency, stalledWarningSeconds: options.stalledWarningSeconds, startedAt: timestamp(), taskIds: contexts.map((context) => context.taskId), paneIds: [],
	};
	await writeJsonAtomic(runFile, runRecord);
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const results = new Array<BatchTaskResult>(tasks.length);
	const activity: BatchResult["activity"] = tasks.map((task, index) => ({ index, name: task.name, status: "queued" }));
	let tabId: string | undefined;
	const paneAllocator = new RunPaneAllocator({ herdr, run: runRecord, runFile, signal: options.signal });
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
			let report: HerdrSubagentsReport;
			let agentName = liveAgentName(context.taskId);
			try {
				paneId = await allocatePane(index);
				const paneLabel = `${String(index + 1).padStart(2, "0")} · ${task.name}`;
				await herdr.renamePane(paneId, paneLabel, options.signal);
				Object.assign(context.taskRecord, { status: "running", tabId, paneId, paneLabel, agentName, startedAt: timestamp() });
				await writeJsonAtomic(context.taskFile, context.taskRecord);
				activity[index] = { index, name: task.name, status: "running", paneId };
				emit("running", `${settled}/${tasks.length} tasks settled.`);
				const prompted = await promptLiveAgent({ herdr, task: { ...task, id: context.taskId, sessionFile: context.sessionFile }, paneId, prompt: task.prompt, systemPromptFile: context.systemPromptFile, agentName, signal: options.signal, stalledWarningMs: options.stalledWarningSeconds ? options.stalledWarningSeconds * 1000 : undefined, onStalled: () => emit("running", `${task.name} appears stalled; it is still running.`) });
				agentName = prompted.agentName;
				report = prompted.report;
			} catch (error) {
				const cancelled = isAbort(error, options.signal);
				const message = cancelled ? "Parent Pi session closed." : error instanceof Error ? error.message : String(error);
				report = { status: "failed", summary: cancelled ? `${task.name} was cancelled.` : `${task.name} failed.`, documents: [], error: message, reportedAt: timestamp() };
				if (!existsSync(context.reportFile)) await writeJsonAtomic(context.reportFile, report);
			}
			const status: BatchTaskResult["status"] = options.signal?.aborted ? "cancelled" : report.status === "needs-input" ? "blocked" : report.status;
			Object.assign(context.taskRecord, { status, paneId, agentName, completedAt: timestamp(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
			await writeJsonAtomic(context.taskFile, context.taskRecord);
			results[index] = { index, name: task.name, status, summary: report.summary, documents: report.documents, ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}), paneId, recordDirectory: context.taskDirectory, sessionFile: context.sessionFile };
			activity[index] = { index, name: task.name, status, ...(paneId ? { paneId } : {}) };
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
		await Promise.all(Array.from({ length: effectiveConcurrency }, worker));
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
		const cancelled = options.signal?.aborted || activity.some((entry) => entry.status === "cancelled");
		const status: BatchResult["status"] = cancelled ? "cancelled" : blocked || activity.some((entry) => entry.status === "queued") ? "blocked" : failed === 0 ? "completed" : failed === tasks.length ? "failed" : "partial";
		const summary = status === "cancelled" ? "Subagent batch cancelled because the parent Pi session closed." : blocked ? `${blocked.name} needs input: ${blocked.question}` : failed ? `${tasks.length - failed}/${tasks.length} tasks completed; ${failed} failed.` : `${tasks.length}/${tasks.length} tasks completed.`;
		Object.assign(runRecord, { status, ...(status === "blocked" ? { question: blocked?.question, updatedAt: timestamp() } : { completedAt: timestamp() }) });
		await writeJsonAtomic(runFile, runRecord);
		return { ok: status === "completed", status, runId, label: options.label, requestedConcurrency, effectiveConcurrency, tasks: settledResults, activity, summary, documents: settledResults.flatMap((result) => result.documents), recordDirectory: runDirectory, tabId };
	} catch (error) {
		Object.assign(runRecord, { status: options.signal?.aborted ? "cancelled" : "failed", completedAt: timestamp(), error: error instanceof Error ? error.message : String(error) });
		await writeJsonAtomic(runFile, runRecord);
		throw error;
	} finally {
		const keepTab = !options.signal?.aborted && activity.some((entry) => entry.status === "blocked" || entry.status === "queued" || entry.status === "running");
		if (tabId && !keepTab) {
			try {
				const cleanupSignal = options.signal?.aborted ? undefined : options.signal;
				if (await herdr.isTabFocused(tabId, cleanupSignal)) void herdr.waitForTabUnfocused(tabId, cleanupSignal).then(() => herdr.closeTab(tabId as string, cleanupSignal)).catch(async (error) => {
					const message = error instanceof Error ? error.message : String(error);
					Object.assign(runRecord, { status: "failed", cleanupError: message });
					await writeJsonAtomic(runFile, runRecord);
					emit("failed", `Task results settled, but Herdr tab cleanup failed: ${message}`);
				});
				else await herdr.closeTab(tabId, cleanupSignal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				Object.assign(runRecord, { status: "failed", cleanupError: message });
				await writeJsonAtomic(runFile, runRecord);
				const cleanupError = new Error(`Task results settled, but Herdr tab cleanup failed: ${message}`) as Error & { recordDirectory: string; runId: string };
				cleanupError.recordDirectory = runDirectory;
				cleanupError.runId = runId;
				throw cleanupError;
			}
		}
	}
}
