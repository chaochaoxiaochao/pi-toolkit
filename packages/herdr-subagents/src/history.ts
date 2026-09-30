import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { aggregateTaskStatus } from "./run-status.ts";

export interface HistoricalTask { order: number; id: string; name: string; agent: string; status: string; summary?: string; question?: string; documents: Array<{ path: string; description: string }>; recordDirectory: string; sessionFile: string; model?: string; thinking?: string; tools?: string[]; skills: string[]; access?: string; }
export interface HistoricalRun { id: string; label: string; status: string; startedAt: string; completedAt?: string; effectiveConcurrency?: number; tasks: HistoricalTask[]; recordDirectory: string; }

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

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
			const run = await readJson(join(directory, "run.json"));
			const tasks: HistoricalTask[] = [];
			const tasksDirectory = join(directory, "tasks");
			if (existsSync(tasksDirectory)) for (const taskEntry of readdirSync(tasksDirectory).sort()) {
				const taskDirectory = join(tasksDirectory, taskEntry);
				const task = await readJson(join(taskDirectory, "task.json"));
				let report: Record<string, any> = {};
				try { report = await readJson(join(taskDirectory, "report.json")); } catch {}
				tasks.push({ order: task.order ?? tasks.length + 1, id: task.id, name: task.name ?? task.agent ?? "worker", agent: task.agent ?? "worker", status: task.status, summary: report.summary, question: report.question, documents: report.documents ?? [], recordDirectory: taskDirectory, sessionFile: task.sessionFile, model: task.model, thinking: task.thinking, tools: task.tools, skills: task.skills ?? [], access: task.access });
			}
			history.push({ id: run.id, label: run.label, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, effectiveConcurrency: run.effectiveConcurrency, tasks, recordDirectory: directory });
		} catch {}
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
	if (["starting", "running", "queued", "blocked"].includes(run.status)) throw new Error(`Subagent run '${runId}' is still active and cannot be cleaned.`);
	await rm(run.recordDirectory, { recursive: true, force: false });
	return true;
}

export interface ResumeHistoricalTaskOptions { herdr?: HerdrAutomation; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; }

export async function resumeHistoricalTask(cwd: string, runId: string, taskNumber: number, prompt: string, options: ResumeHistoricalTaskOptions = {}): Promise<{ runId: string; status: string; summary: string; documents: any[]; tabId: string; paneId: string; sessionFile: string }> {
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const { signal, onCleanupError } = options;
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId);
	const historical = run?.tasks.find((task) => task.order === taskNumber);
	if (!run || !historical) throw new Error(`Unknown historical task ${runId}#${taskNumber}.`);
	if (!existsSync(historical.sessionFile)) throw new Error(`Historical task ${runId}#${taskNumber} has no saved Pi session.`);
	const taskFile = join(historical.recordDirectory, "task.json");
	const task = await readJson(taskFile);
	const attempt = Number(task.attempt ?? 1) + 1;
	const turnsDirectory = join(historical.recordDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const initialTurnFile = join(turnsDirectory, "01.json");
	if (!existsSync(initialTurnFile)) {
		const initialReport = await readJson(join(historical.recordDirectory, "report.json"));
		await writeJsonAtomic(initialTurnFile, { attempt: 1, prompt: task.prompt, status: task.status, summary: initialReport.summary, question: initialReport.question, error: initialReport.error, documents: initialReport.documents ?? [], sessionFile: historical.sessionFile, startedAt: task.startedAt, completedAt: task.completedAt });
	}
	const turnFile = join(turnsDirectory, `${String(attempt).padStart(2, "0")}.json`);
	const followupPrompt = join(historical.recordDirectory, "followup-system-prompt.md");
	await writeTextAtomic(followupPrompt, "This is a new turn in the same logical task. When this turn is finished, call subagent_report exactly once for this turn.\n");
	const env = { PI_HERDR_SUBAGENTS_CHILD: "1", PI_HERDR_SUBAGENTS_TASK_DIR: historical.recordDirectory };
	let tab: { tabId: string; paneId: string } | undefined;
	const agentName = liveAgentName(historical.id, attempt);
	try {
		tab = await retryBeforePrompt(() => herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd, label: `SA · ${run.label}`, env, focus: false, signal }));
		const paneLabel = `${String(historical.order).padStart(2, "0")} · ${historical.name}`;
		await herdr.renamePane(tab.paneId, paneLabel, signal);
		Object.assign(task, { status: "running", attempt, currentTurnFile: turnFile, tabId: tab.tabId, paneId: tab.paneId, paneLabel, agentName, updatedAt: new Date().toISOString() });
		const activeRunRecord = await readJson(join(run.recordDirectory, "run.json"));
		const paneIds = [...new Set([...(Array.isArray(activeRunRecord.paneIds) ? activeRunRecord.paneIds : []), tab.paneId])];
		Object.assign(activeRunRecord, { status: "running", ...ownerRecord(options.owner), tabId: tab.tabId, paneIds, updatedAt: new Date().toISOString() });
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status: "running", sessionFile: historical.sessionFile, tabId: tab.tabId, paneId: tab.paneId, agentName, startedAt: new Date().toISOString() }),
			writeJsonAtomic(join(run.recordDirectory, "run.json"), activeRunRecord),
		]);
		const { report } = await promptLiveAgent({ herdr, task: { ...task, id: historical.id, sessionFile: historical.sessionFile }, paneId: tab.paneId, prompt, systemPromptFile: followupPrompt, agentName, signal });
		const status = report.status === "needs-input" ? "blocked" : report.status;
		Object.assign(task, { status, completedAt: new Date().toISOString(), ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}) });
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status, summary: report.summary, documents: report.documents ?? [], sessionFile: historical.sessionFile, tabId: tab.tabId, paneId: tab.paneId, agentName, completedAt: new Date().toISOString(), ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}) }),
		]);
		const runRecord = await readJson(join(run.recordDirectory, "run.json"));
		const aggregateStatus = aggregateTaskStatus((await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId)?.tasks.map((entry) => entry.status) ?? [status]);
		Object.assign(runRecord, { status: aggregateStatus, ...ownerRecord(options.owner), tabId: tab.tabId, ...(aggregateStatus === "blocked" ? { question: report.question, updatedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }) });
		await writeJsonAtomic(join(run.recordDirectory, "run.json"), runRecord);
		if (status !== "blocked") {
			await cleanupRunTab({ herdr, tabId: tab.tabId, runFile: join(run.recordDirectory, "run.json"), runRecord, signal, onError: onCleanupError });
		}
		return { runId, status, summary: report.summary, documents: report.documents ?? [], tabId: tab.tabId, paneId: tab.paneId, sessionFile: historical.sessionFile };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = signal?.aborted ? "cancelled" : "failed";
		Object.assign(task, { status, attempt, completedAt: new Date().toISOString(), error: message });
		const runRecord = await readJson(join(run.recordDirectory, "run.json"));
		const aggregateStatus = aggregateTaskStatus(run.tasks.map((entry) => entry.id === historical.id ? status : entry.status));
		Object.assign(runRecord, { status: aggregateStatus, ...ownerRecord(options.owner), completedAt: new Date().toISOString(), error: message, ...(tab ? { tabId: tab.tabId } : {}) });
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status, error: message, sessionFile: historical.sessionFile, ...(tab ? { tabId: tab.tabId, paneId: tab.paneId } : {}), completedAt: new Date().toISOString() }),
			writeJsonAtomic(join(run.recordDirectory, "run.json"), runRecord),
		]);
		if (tab) await cleanupRunTab({ herdr, tabId: tab.tabId, runFile: join(run.recordDirectory, "run.json"), runRecord, onError: onCleanupError }).catch(() => undefined);
		throw error;
	}
}
