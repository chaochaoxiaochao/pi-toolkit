import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { continueQueuedRun } from "./continue-run.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";
import { aggregateTaskStatus } from "./run-status.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }
export interface RespondToBlockedTaskOptions { herdr?: HerdrAutomation; taskNumber?: number; signal?: AbortSignal; owner?: OwnerIdentity; onCleanupError?: (message: string) => void; }
export interface ResumeBlockedResult {
	ok: boolean;
	runId: string;
	label: string;
	status: "blocked" | "completed" | "partial" | "failed" | "cancelled";
	summary: string;
	question?: string;
	documents: Array<{ path: string; description: string }>;
	recordDirectory: string;
	requestedConcurrency: number;
	effectiveConcurrency: number;
	tasks?: Array<{ index: number; name: string; status: string; summary: string; documents: Array<{ path: string; description: string }>; error?: string; question?: string; paneId: string; recordDirectory: string; sessionFile: string }>;
	activity?: Array<{ index: number; name: string; status: string; paneId?: string }>;
	tabId?: string;
}

export async function respondToBlockedTask(cwd: string, runId: string, answer: string, options: RespondToBlockedTaskOptions = {}): Promise<ResumeBlockedResult> {
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const { taskNumber, signal, onCleanupError } = options;
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	const runDirectory = readdirSync(runsDirectory).map((entry) => join(runsDirectory, entry)).find((directory) => {
		try { return JSON.parse(readFileSync(join(directory, "run.json"), "utf8")).id === runId; } catch { return false; }
	});
	if (!runDirectory) throw new Error(`Unknown Subagent run '${runId}'.`);
	const runFile = join(runDirectory, "run.json");
	const run = await readJson(runFile);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	let taskDirectory: string | undefined;
	let task: Record<string, any> | undefined;
	for (const directory of taskDirectories) {
		const candidate = await readJson(join(directory, "task.json"));
		if (candidate.status === "blocked" && (!taskNumber || candidate.order === taskNumber)) { taskDirectory = directory; task = candidate; break; }
	}
	if (!taskDirectory || !task) throw new Error(`Run '${runId}' has no blocked task.`);
	Object.assign(run, ownerRecord(options.owner));
	const previousReport = await readJson(join(taskDirectory, "report.json"));
	const turnsDirectory = join(taskDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const turnFile = String(task.currentTurnFile ?? join(turnsDirectory, `${String(Number(task.attempt ?? 1)).padStart(2, "0")}.json`));
	let turn: Record<string, any>;
	try { turn = await readJson(turnFile); }
	catch { turn = { attempt: Number(task.attempt ?? 1), prompt: task.prompt, status: "blocked", summary: previousReport.summary, question: previousReport.question, documents: previousReport.documents ?? [], sessionFile: task.sessionFile, startedAt: task.startedAt }; }
	turn.events = [...(Array.isArray(turn.events) ? turn.events : []), { type: "answer", text: answer, at: new Date().toISOString() }];
	task.currentTurnFile = turnFile;
	const resumePrompt = join(taskDirectory, "resume-system-prompt.md");
	await writeTextAtomic(resumePrompt, "This is a resumed turn. When this turn is finished, call subagent_report exactly once for this turn, even if an earlier turn already used it.\n");
	let paneId = String(task.paneId ?? "");
	let agentName = String(task.agentName ?? liveAgentName(task.id));
	let live = Boolean(paneId) && await herdr.paneExists(paneId, signal) && await herdr.isTaskRunning(paneId, signal);
	if (!live) {
		paneId = "";
		const env = { PI_HERDR_SUBAGENTS_CHILD: "1", PI_HERDR_SUBAGENTS_TASK_DIR: taskDirectory };
		const anchorPane = Array.isArray(run.paneIds) ? run.paneIds.at(-1) : undefined;
		const anchorExists = Boolean(run.tabId && anchorPane && await herdr.paneExists(anchorPane, signal));
		if (anchorExists) {
			try {
				const split = await retryBeforePrompt(() => herdr.splitPane({ paneId: anchorPane, cwd: run.cwd ?? cwd, direction: "right", focus: false, env, signal }));
				paneId = split.paneId;
				run.paneIds.push(paneId);
			} catch { paneId = ""; }
		}
		if (!paneId) {
			const staleTabId = run.tabId;
			const tab = await retryBeforePrompt(() => herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: run.cwd ?? cwd, label: `SA · ${run.label}`, env, focus: false, signal }));
			run.tabId = tab.tabId;
			paneId = tab.paneId;
			run.paneIds = [paneId];
			if (staleTabId) await herdr.closeTab(staleTabId).catch(() => undefined);
		}
		agentName = liveAgentName(task.id, Number(task.attempt ?? 1) + 1);
		task.attempt = Number(task.attempt ?? 1) + 1;
		await herdr.renamePane(paneId, `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent}`, signal);
	}
	Object.assign(task, { status: "running", tabId: run.tabId, paneId, agentName, updatedAt: new Date().toISOString() });
	await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(runFile, run), writeJsonAtomic(turnFile, turn)]);
	let report: Record<string, any>;
	try {
		({ report } = await promptLiveAgent({ herdr, task: { ...task, id: task.id, sessionFile: task.sessionFile }, paneId, prompt: answer, systemPromptFile: resumePrompt, agentName, start: !live, signal }));
	} catch (error) {
		const cancelled = signal?.aborted === true;
		const message = error instanceof Error ? error.message : String(error);
		const status = cancelled ? "cancelled" : "failed";
		Object.assign(task, { status, completedAt: new Date().toISOString(), error: message });
		Object.assign(run, { status, completedAt: new Date().toISOString(), error: message });
		Object.assign(turn, { status, error: message, completedAt: new Date().toISOString() });
		for (const siblingDirectory of taskDirectories) {
			if (siblingDirectory === taskDirectory) continue;
			const siblingFile = join(siblingDirectory, "task.json");
			const sibling = await readJson(siblingFile);
			if (!["starting", "running", "queued", "blocked"].includes(sibling.status)) continue;
			Object.assign(sibling, { status: "cancelled", completedAt: new Date().toISOString(), error: `Run ended because ${task.name ?? task.agent} could not continue.` });
			await writeJsonAtomic(siblingFile, sibling);
		}
		await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(runFile, run), writeJsonAtomic(turnFile, turn)]);
		if (run.tabId) await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, onError: onCleanupError }).catch(() => undefined);
		return { ok: false, runId, label: String(run.label ?? "batch"), status, summary: cancelled ? "Subagent response cancelled." : `Subagent response failed: ${message}`, documents: [], recordDirectory: runDirectory, requestedConcurrency: Number(run.requestedConcurrency ?? 1), effectiveConcurrency: Number(run.effectiveConcurrency ?? 1), ...(run.tabId ? { tabId: String(run.tabId) } : {}) };
	}
	const status = report.status === "needs-input" ? "blocked" : report.status;
	turn.events.push({ type: "report", status, summary: report.summary, question: report.question, error: report.error, at: new Date().toISOString() });
	Object.assign(turn, { status, summary: report.summary, documents: report.documents ?? [], ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}), completedAt: new Date().toISOString() });
	Object.assign(task, { status, completedAt: new Date().toISOString(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
	await Promise.all([writeJsonAtomic(join(taskDirectory, "task.json"), task), writeJsonAtomic(turnFile, turn)]);
	if (status !== "blocked") {
		Object.assign(run, { status: "queued", updatedAt: new Date().toISOString() });
		await writeJsonAtomic(runFile, run);
		await continueQueuedRun(runDirectory, herdr, { cleanup: false, signal });
	}
	const finalTasks = await Promise.all(taskDirectories.map((directory) => readJson(join(directory, "task.json"))));
	const finalReports = await Promise.all(taskDirectories.map(async (directory) => { try { return await readJson(join(directory, "report.json")); } catch { return { summary: "Task has no report.", documents: [] }; } }));
	const statuses = finalTasks.map((entry) => entry.status);
	const aggregateStatus = aggregateTaskStatus(statuses);
	const runStatus = aggregateStatus === "running" ? "blocked" : aggregateStatus;
	const blockedIndex = finalTasks.findIndex((entry) => entry.status === "blocked");
	const blockedReport = blockedIndex >= 0 ? finalReports[blockedIndex] : undefined;
	Object.assign(run, { status: runStatus, ...(runStatus === "blocked" ? { question: blockedReport?.question, updatedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }) });
	await writeJsonAtomic(runFile, run);
	if (runStatus !== "blocked" && run.tabId) {
		await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, onError: onCleanupError });
	}
	const summary = runStatus === "completed" ? "All tasks completed after the answer." : runStatus === "blocked" ? `${finalTasks[blockedIndex]?.name ?? "Task"} needs input: ${blockedReport?.question ?? "Input required."}` : finalReports.map((entry, index) => `${finalTasks[index].name}: ${entry.summary}`).join("\n");
	const activity = finalTasks.map((entry, index) => ({ index, name: String(entry.name ?? entry.agent ?? `Task ${index + 1}`), status: String(entry.status), ...(entry.paneId ? { paneId: String(entry.paneId) } : {}) }));
	const tasks = finalTasks.map((entry, index) => ({
		index,
		name: activity[index].name,
		status: String(entry.status),
		summary: String(finalReports[index].summary ?? "Task has no report."),
		documents: finalReports[index].documents ?? [],
		...(entry.error ? { error: String(entry.error) } : {}),
		...(entry.question ? { question: String(entry.question) } : {}),
		paneId: String(entry.paneId ?? ""),
		recordDirectory: taskDirectories[index],
		sessionFile: String(entry.sessionFile ?? ""),
	}));
	return { ok: runStatus === "completed", runId, label: String(run.label ?? "batch"), status: runStatus, summary, ...(blockedReport?.question ? { question: blockedReport.question } : {}), documents: finalReports.flatMap((entry) => entry.documents ?? []), recordDirectory: runDirectory, requestedConcurrency: Number(run.requestedConcurrency ?? run.effectiveConcurrency ?? 1), effectiveConcurrency: Number(run.effectiveConcurrency ?? 1), tasks, activity, ...(run.tabId ? { tabId: String(run.tabId) } : {}) };
}
