import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { isActiveStatus, readReport, readRunRecord, readTaskRecord, type PersistedDocument, type RunStatus, type TaskActivity, type TaskRecord, type TaskStatus } from "./records.ts";
import { findRunDirectory } from "./run-locator.ts";
import { resumeHistoricalTaskConcurrent } from "./historical-resume.ts";

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
	const runDirectory = await findRunDirectory(join(cwd, ".pi", "herdr-subagents", "runs"), runId);
	if (!runDirectory) return false;
	const canonicalRunId = (await readRunRecord(join(runDirectory, "run.json"))).id;
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === canonicalRunId);
	if (!run) return false;
	if (isActiveStatus(run.status)) throw new Error(`Subagent run '${canonicalRunId}' is still active and cannot be cleaned.`);
	if (run.cleanupPendingTabIds?.length) throw new Error(`Subagent run '${canonicalRunId}' is still waiting to clean up Herdr tabs ${run.cleanupPendingTabIds.join(", ")}.`);
	await rm(run.recordDirectory, { recursive: true, force: false });
	return true;
}

export interface ResumeHistoricalTaskOptions { herdr?: HerdrAutomation; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; stalledWarningSeconds?: number; onStalled?: (message: string) => void; onUpdate?: (result: ResumeHistoricalTaskResult) => void; }
export interface ResumeHistoricalTaskResult { runId: string; label: string; status: TaskStatus; summary: string; documents: PersistedDocument[]; tabId: string; paneId: string; sessionFile: string; activity: TaskActivity[]; }

export async function resumeHistoricalTask(cwd: string, runId: string, taskNumber: number, prompt: string, options: ResumeHistoricalTaskOptions = {}): Promise<ResumeHistoricalTaskResult> {
	return resumeHistoricalTaskConcurrent(cwd, runId, taskNumber, prompt, options);
}
