import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import { childEnvironment, liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, isActiveStatus, projectTaskActivity, readReport, readRunRecord, readTaskRecord, settleAttemptFailure, type PersistedDocument, type PersistedReport, type RunRecord, type RunStatus, type TaskActivity, type TaskRecord, type TaskStatus } from "./records.ts";
import { continuationSystemPrompt } from "./protocol.ts";
import { isAbortError } from "./errors.ts";
import { findRunDirectory } from "./run-locator.ts";

export interface HistoricalTask { order: number; id: string; name: string; agent: string; status: TaskStatus; summary?: string; question?: string; documents: PersistedDocument[]; recordDirectory: string; sessionFile: string; model?: string; thinking?: string; tools?: string[]; skills: string[]; access?: string; }
export interface HistoricalRun { id: string; label: string; status: RunStatus; startedAt: string; completedAt?: string; effectiveConcurrency?: number; cleanupPendingTabIds?: string[]; tasks: HistoricalTask[]; recordDirectory: string; }

export async function ensureRuntimeIgnored(cwd: string): Promise<void> {
	const piDirectory = join(cwd, ".pi");
	await mkdir(piDirectory, { recursive: true, mode: 0o700 });
	const dotGit = join(cwd, ".git");
	let ignoreFile = join(piDirectory, ".gitignore");
	let line = "herdr-subagents/runs/";
	if (existsSync(dotGit)) {
		let gitDirectory = dotGit;
		if (!statSync(dotGit).isDirectory()) {
			const configured = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
			if (configured) gitDirectory = isAbsolute(configured) ? configured : join(cwd, configured);
		}
		const commonDirectoryFile = join(gitDirectory, "commondir");
		const commonDirectory = existsSync(commonDirectoryFile) ? join(gitDirectory, readFileSync(commonDirectoryFile, "utf8").trim()) : gitDirectory;
		ignoreFile = join(commonDirectory, "info", "exclude");
		line = "/.pi/herdr-subagents/runs/";
		await mkdir(join(commonDirectory, "info"), { recursive: true });
	}
	const current = existsSync(ignoreFile) ? await readFile(ignoreFile, "utf8") : "";
	if (current.split(/\r?\n/).includes(line)) return;
	await appendFile(ignoreFile, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function listSubagentHistory(cwd: string): Promise<HistoricalRun[]> {
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return [];
	const history: HistoricalRun[] = [];
	for (const entry of readdirSync(runsDirectory).sort().reverse()) {
		const directory = join(runsDirectory, entry);
		try {
			const run = await readRunRecord(join(directory, "run.json"));
			const tasks: HistoricalTask[] = [];
			let projectedStatus = run.status;
			const tasksDirectory = join(directory, "tasks");
			if (existsSync(tasksDirectory)) for (const taskEntry of readdirSync(tasksDirectory).sort()) {
				const taskDirectory = join(tasksDirectory, taskEntry);
				let task: TaskRecord;
				try { task = await readTaskRecord(join(taskDirectory, "task.json")); }
				catch (error) {
					projectedStatus = "failed";
					tasks.push({ order: tasks.length + 1, id: taskEntry, name: taskEntry, agent: "unknown", status: "failed", summary: `Invalid durable task: ${error instanceof Error ? error.message : String(error)}`, documents: [], recordDirectory: taskDirectory, sessionFile: join(taskDirectory, "session.jsonl"), skills: [] });
					continue;
				}
				let report: { summary?: string; question?: string; documents: Array<{ path: string; description: string }> } = { documents: [] };
				let historyStatus = task.status;
				const reportFile = join(taskDirectory, "report.json");
				if (existsSync(reportFile)) {
					try { report = await readReport(reportFile); }
					catch (error) {
						historyStatus = "failed";
						report = { summary: `Invalid durable report: ${error instanceof Error ? error.message : String(error)}`, documents: [] };
					}
				} else if (["completed", "failed", "blocked"].includes(task.status)) {
					historyStatus = "failed";
					report = { summary: `Missing structured report: ${reportFile}`, documents: [] };
				}
				tasks.push({ order: task.order ?? tasks.length + 1, id: task.id, name: task.name ?? task.agent ?? "worker", agent: task.agent ?? "worker", status: historyStatus, summary: report.summary, question: report.question, documents: report.documents ?? [], recordDirectory: taskDirectory, sessionFile: task.sessionFile, model: task.model, thinking: task.thinking, tools: task.tools, skills: task.skills ?? [], access: task.access });
			}
			history.push({ id: run.id, label: run.label, status: projectedStatus, startedAt: run.startedAt, completedAt: run.completedAt, effectiveConcurrency: run.effectiveConcurrency, cleanupPendingTabIds: run.cleanupPendingTabIds, tasks, recordDirectory: directory });
		} catch (error) {
			history.push({ id: entry, label: "Unreadable Subagent run", status: "failed", startedAt: "", tasks: [{ order: 1, id: `${entry}-invalid`, name: "Invalid durable run", agent: "unknown", status: "failed", summary: `Could not read Subagent history ${directory}: ${error instanceof Error ? error.message : String(error)}`, documents: [], recordDirectory: directory, sessionFile: join(directory, "session.jsonl"), skills: [] }], recordDirectory: directory });
		}
	}
	return history;
}

export function historyText(history: HistoricalRun[]): string {
	if (!history.length) return "No Subagent history in this project.";
	return history.flatMap((run) => [`${run.id} · ${run.label} · ${run.status} · ${run.tasks.length} tasks`, ...run.tasks.map((task) => `  ${task.order}. ${task.name}: ${task.status}${task.summary ? ` — ${task.summary}` : ""}`)]).join("\n");
}

export async function cleanSubagentRun(cwd: string, runId: string): Promise<boolean> {
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId);
	if (!run) return false;
	if (isActiveStatus(run.status)) throw new Error(`Subagent run '${runId}' is still active and cannot be cleaned.`);
	if (run.cleanupPendingTabIds?.length) throw new Error(`Subagent run '${runId}' is still waiting to clean up Herdr tabs ${run.cleanupPendingTabIds.join(", ")}.`);
	await rm(run.recordDirectory, { recursive: true, force: false });
	return true;
}

export interface ResumeHistoricalTaskOptions { herdr?: HerdrAutomation; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; stalledWarningSeconds?: number; onStalled?: (message: string) => void; onUpdate?: (result: ResumeHistoricalTaskResult) => void; }
export interface ResumeHistoricalTaskResult { runId: string; label: string; status: TaskStatus; summary: string; documents: PersistedDocument[]; tabId: string; paneId: string; sessionFile: string; activity: TaskActivity[]; }

export async function resumeHistoricalTask(cwd: string, runId: string, taskNumber: number, prompt: string, options: ResumeHistoricalTaskOptions = {}): Promise<ResumeHistoricalTaskResult> {
	const runDirectory = await findRunDirectory(join(cwd, ".pi", "herdr-subagents", "runs"), runId);
	if (!runDirectory) throw new Error(`Unknown Subagent run '${runId}'.`);
	const lockDirectory = join(runDirectory, ".resume.lock");
	try { await mkdir(lockDirectory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Subagent run '${runId}' already has a historical resume in progress (lock: ${lockDirectory}).`);
		throw error;
	}
	try { return await resumeHistoricalTaskLocked(cwd, runId, taskNumber, prompt, options); }
	finally { await rmdir(lockDirectory); }
}

async function resumeHistoricalTaskLocked(cwd: string, runId: string, taskNumber: number, prompt: string, options: ResumeHistoricalTaskOptions): Promise<ResumeHistoricalTaskResult> {
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const { signal, onCleanupError } = options;
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId);
	const historical = run?.tasks.find((task) => task.order === taskNumber);
	if (!run || !historical) throw new Error(`Unknown historical task ${runId}#${taskNumber}.`);
	if (isActiveStatus(run.status)) throw new Error(`Subagent run '${runId}' is still active. Use action 'respond' for blocked work or wait for it to settle before resuming history.`);
	if (run.cleanupPendingTabIds?.length) throw new Error(`Subagent run '${runId}' is still waiting to clean up Herdr tabs ${run.cleanupPendingTabIds.join(", ")}.`);
	if (!existsSync(historical.sessionFile)) throw new Error(`Historical task ${runId}#${taskNumber} has no saved Pi session.`);
	const taskFile = join(historical.recordDirectory, "task.json");
	const task = await readTaskRecord(taskFile);
	const attempt = Number(task.attempt ?? 1) + 1;
	const turnsDirectory = join(historical.recordDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const initialTurnFile = join(turnsDirectory, "01.json");
	if (!existsSync(initialTurnFile)) {
		const initialReportFile = join(historical.recordDirectory, "report.json");
		let initialReport;
		try { initialReport = await readReport(initialReportFile); }
		catch (error) { initialReport = { status: "failed" as const, summary: `Previous structured report was unavailable: ${error instanceof Error ? error.message : String(error)}`, documents: [] }; }
		await writeJsonAtomic(initialTurnFile, { attempt: 1, prompt: task.prompt, status: task.status, summary: initialReport.summary, question: initialReport.question, error: initialReport.error, documents: initialReport.documents ?? [], sessionFile: historical.sessionFile, startedAt: task.startedAt, completedAt: task.completedAt });
	}
	const turnFile = join(turnsDirectory, `${String(attempt).padStart(2, "0")}.json`);
	const followupPrompt = join(historical.recordDirectory, "followup-system-prompt.md");
	await writeTextAtomic(followupPrompt, `${continuationSystemPrompt(task.systemPrompt, "Continue the requested historical work.", "followup")}\n`);
	let tab: { tabId: string; paneId: string } | undefined;
	let failedAttempt: { status: "cancelled" | "failed"; report: PersistedReport; error: unknown } | undefined;
	const agentName = liveAgentName(historical.id, attempt);
	try {
		let report: PersistedReport;
		let status: "blocked" | "completed" | "failed";
		try {
			const env = childEnvironment(historical.recordDirectory);
			tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd, label: `SA · ${run.label}`, env, focus: false, signal: options.signal });
			const paneLabel = `${String(historical.order).padStart(2, "0")} · ${historical.name}`;
			await herdr.renamePane(tab.paneId, paneLabel, options.signal);
			applyTaskStatus(task, "running");
			Object.assign(task, { attempt, currentTurnFile: turnFile, tabId: tab.tabId, paneId: tab.paneId, paneLabel, agentName });
			const activeRunFile = join(run.recordDirectory, "run.json");
			const activeRunRecord = await readRunRecord(activeRunFile);
			applyRunStatus(activeRunRecord, "running");
			Object.assign(activeRunRecord, { ...ownerRecord(options.owner), tabId: tab.tabId, paneIds: [...new Set([...(activeRunRecord.paneIds ?? []), tab.paneId])] });
			await Promise.all([
				writeJsonAtomic(taskFile, task),
				writeJsonAtomic(turnFile, { attempt, prompt, status: "running", sessionFile: historical.sessionFile, tabId: tab.tabId, paneId: tab.paneId, agentName, startedAt: new Date().toISOString() }),
				writeJsonAtomic(activeRunFile, activeRunRecord),
			]);
			const runningActivity = await Promise.all(run.tasks.map(async (entry, index) => projectTaskActivity(await readTaskRecord(join(entry.recordDirectory, "task.json")), index)));
			options.onUpdate?.({ runId, label: run.label, status: "running", summary: `${historical.name} is continuing.`, documents: [], tabId: tab.tabId, paneId: tab.paneId, sessionFile: historical.sessionFile, activity: runningActivity });
			report = (await promptLiveAgent({ herdr, task: { ...task, id: historical.id, sessionFile: historical.sessionFile }, paneId: tab.paneId, prompt, systemPromptFile: followupPrompt, agentName, signal, stalledWarningMs: options.stalledWarningSeconds ? options.stalledWarningSeconds * 1000 : undefined, onStalled: () => options.onStalled?.(`${historical.name} appears stalled; it is still running.`) })).report;
			status = applyReport(task, report);
		} catch (error) {
			const settled = await settleAttemptFailure(task, join(historical.recordDirectory, "report.json"), {
				cancelled: isAbortError(error, signal),
				error: error instanceof Error ? error.message : String(error),
				name: `${historical.name} follow-up`,
				replaceReport: true,
			});
			failedAttempt = { ...settled, error };
			throw error;
		}
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status, summary: report.summary, documents: report.documents ?? [], sessionFile: historical.sessionFile, tabId: tab.tabId, paneId: tab.paneId, agentName, completedAt: new Date().toISOString(), ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}) }),
		]);
		const runRecord = await readRunRecord(join(run.recordDirectory, "run.json"));
		const aggregateStatus = aggregateTaskStatus((await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId)?.tasks.map((entry) => entry.status) ?? [status]);
		applyRunStatus(runRecord, aggregateStatus, { question: report.question });
		Object.assign(runRecord, { ...ownerRecord(options.owner), tabId: tab.tabId });
		await writeJsonAtomic(join(run.recordDirectory, "run.json"), runRecord);
		if (status !== "blocked") {
			await cleanupRunTab({ herdr, tabId: tab.tabId, runFile: join(run.recordDirectory, "run.json"), runRecord, signal, onError: onCleanupError, failureStatus: "failed" });
		}
		const activity = await Promise.all(run.tasks.map(async (entry, index) => projectTaskActivity(await readTaskRecord(join(entry.recordDirectory, "task.json")), index)));
		return { runId, label: run.label, status, summary: report.summary, documents: report.documents ?? [], tabId: tab.tabId, paneId: tab.paneId, sessionFile: historical.sessionFile, activity };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const completedAt = new Date().toISOString();
		const settled = failedAttempt ?? await settleAttemptFailure(task, join(historical.recordDirectory, "report.json"), {
			cancelled: isAbortError(error, signal),
			error: message,
			name: `${historical.name} follow-up`,
			at: completedAt,
			replaceReport: true,
		});
		const { status, report } = settled;
		task.attempt = attempt;
		const runRecord = await readRunRecord(join(run.recordDirectory, "run.json"));
		const aggregateStatus = status === "cancelled" ? "cancelled" : aggregateTaskStatus(run.tasks.map((entry) => entry.id === historical.id ? status : entry.status));
		applyRunStatus(runRecord, aggregateStatus, { error: message });
		Object.assign(runRecord, { ...ownerRecord(options.owner), ...(tab ? { tabId: tab.tabId } : {}) });
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status, summary: report.summary, documents: report.documents, error: message, sessionFile: historical.sessionFile, ...(tab ? { tabId: tab.tabId, paneId: tab.paneId } : {}), completedAt }),
			writeJsonAtomic(join(run.recordDirectory, "run.json"), runRecord),
		]);
		const activity = await Promise.all(run.tasks.map(async (entry, index) => projectTaskActivity(await readTaskRecord(join(entry.recordDirectory, "task.json")), index)));
		options.onUpdate?.({ runId, label: run.label, status, summary: report.summary, documents: report.documents, tabId: tab?.tabId ?? "", paneId: tab?.paneId ?? "", sessionFile: historical.sessionFile, activity });
		if (tab) await cleanupRunTab({ herdr, tabId: tab.tabId, runFile: join(run.recordDirectory, "run.json"), runRecord, signal, onError: onCleanupError, failureStatus: "failed" });
		throw error;
	}
}
