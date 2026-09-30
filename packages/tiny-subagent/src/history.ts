import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";

export interface HistoricalTask { order: number; id: string; name: string; status: string; summary?: string; question?: string; recordDirectory: string; sessionFile: string; model?: string; thinking?: string; tools?: string[]; skills: string[]; access?: string; }
export interface HistoricalRun { id: string; label: string; status: string; startedAt: string; completedAt?: string; effectiveConcurrency?: number; tasks: HistoricalTask[]; recordDirectory: string; }

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

export async function ensureRuntimeIgnored(cwd: string): Promise<void> {
	const piDirectory = join(cwd, ".pi");
	await mkdir(piDirectory, { recursive: true, mode: 0o700 });
	const dotGit = join(cwd, ".git");
	let ignoreFile = join(piDirectory, ".gitignore");
	let line = "herdr-subagents/";
	if (existsSync(dotGit)) {
		let gitDirectory = dotGit;
		if (!statSync(dotGit).isDirectory()) {
			const configured = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
			if (configured) gitDirectory = isAbsolute(configured) ? configured : join(cwd, configured);
		}
		const commonDirectoryFile = join(gitDirectory, "commondir");
		const commonDirectory = existsSync(commonDirectoryFile) ? join(gitDirectory, readFileSync(commonDirectoryFile, "utf8").trim()) : gitDirectory;
		ignoreFile = join(commonDirectory, "info", "exclude");
		line = "/.pi/herdr-subagents/";
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
				tasks.push({ order: task.order ?? tasks.length + 1, id: task.id, name: task.name ?? task.agent, status: task.status, summary: report.summary, question: report.question, recordDirectory: taskDirectory, sessionFile: task.sessionFile, model: task.model, thinking: task.thinking, tools: task.tools, skills: task.skills ?? [], access: task.access });
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
	await rm(run.recordDirectory, { recursive: true, force: false });
	return true;
}

export async function resumeHistoricalTask(cwd: string, runId: string, taskNumber: number, prompt: string, herdr: HerdrAutomation = new CliHerdrAutomation()): Promise<{ runId: string; status: string; summary: string; documents: any[]; tabId: string; paneId: string; sessionFile: string }> {
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId);
	const historical = run?.tasks.find((task) => task.order === taskNumber);
	if (!run || !historical) throw new Error(`Unknown historical task ${runId}#${taskNumber}.`);
	const followupOrder = Math.max(0, ...run.tasks.map((task) => task.order)) + 1;
	const followupDirectory = join(run.recordDirectory, "tasks", `${String(followupOrder).padStart(2, "0")}-followup-${Date.now()}`);
	await mkdir(followupDirectory, { recursive: true, mode: 0o700 });
	const followupPrompt = join(followupDirectory, "system-prompt.md");
	await writeTextAtomic(followupPrompt, "This is a new resumed task. When this turn is finished, call subagent_report exactly once for this turn, even if an earlier turn already used it.\n");
	const followupTask: Record<string, any> = { id: `followup-${Date.now()}`, runId, order: followupOrder, name: `${historical.name} follow-up`, status: "starting", prompt, agent: "historical", access: historical.access, model: historical.model, thinking: historical.thinking, tools: historical.tools, skills: historical.skills, sessionFile: historical.sessionFile, startedAt: new Date().toISOString() };
	await writeJsonAtomic(join(followupDirectory, "task.json"), followupTask);
	const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", historical.sessionFile, "--name", `Subagent: ${historical.name}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", followupPrompt];
	const originalSystemPrompt = join(historical.recordDirectory, "system-prompt.md");
	if (existsSync(originalSystemPrompt)) args.push("--append-system-prompt", originalSystemPrompt);
	if (historical.model) args.push("--model", historical.model);
	if (historical.thinking) args.push("--thinking", historical.thinking);
	if (historical.tools?.length) args.push("--tools", [...new Set([...historical.tools, "subagent_report"])].join(","));
	for (const skill of historical.skills) args.push("--skill", skill);
	let tab: { tabId: string; paneId: string } | undefined;
	let report: Record<string, any>;
	try {
		tab = await retryBeforePrompt(() => herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd, label: `SA · resume · ${historical.name}`, env: { PI_SUBAGENT_CHILD: "1" }, focus: false }));
		Object.assign(followupTask, { status: "running", paneId: tab.paneId });
		await writeJsonAtomic(join(followupDirectory, "task.json"), followupTask);
		await retryBeforePrompt(() => herdr.prepareTask(args));
		await herdr.runTask({ paneId: tab.paneId, args, prompt, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: followupDirectory }, marker: `PI_SUBAGENT_HISTORY_${Date.now()}` });
		report = await readJson(join(followupDirectory, "report.json"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		Object.assign(followupTask, { status: "failed", completedAt: new Date().toISOString(), error: message });
		await writeJsonAtomic(join(followupDirectory, "task.json"), followupTask);
		await writeJsonAtomic(join(followupDirectory, "report.json"), { status: "failed", summary: `${historical.name} follow-up failed.`, documents: [], error: message, reportedAt: new Date().toISOString() });
		const failedRun = await readJson(join(run.recordDirectory, "run.json"));
		Object.assign(failedRun, { status: "partial", completedAt: new Date().toISOString(), error: message });
		await writeJsonAtomic(join(run.recordDirectory, "run.json"), failedRun);
		if (tab) await herdr.closeTab(tab.tabId).catch(() => undefined);
		throw error;
	}
	if (!tab) throw new Error("Historical resume did not create a Herdr tab.");
	await writeJsonAtomic(join(followupDirectory, "followup.json"), { prompt, sessionFile: historical.sessionFile, paneId: tab.paneId, reportedAt: new Date().toISOString() });
	const status = report.status === "needs-input" ? "blocked" : report.status;
	Object.assign(followupTask, { status, completedAt: new Date().toISOString(), ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}) });
	await writeJsonAtomic(join(followupDirectory, "task.json"), followupTask);
	const runRecord = await readJson(join(run.recordDirectory, "run.json"));
	const taskStatuses = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId)?.tasks.map((task) => task.status) ?? [status];
	const aggregateStatus = taskStatuses.some((value) => value === "blocked" || value === "queued" || value === "running") ? "blocked" : taskStatuses.some((value) => value === "failed" || value === "interrupted") ? (taskStatuses.some((value) => value === "completed") ? "partial" : "failed") : "completed";
	Object.assign(runRecord, { status: aggregateStatus, tabId: tab.tabId, paneIds: [tab.paneId], ...(aggregateStatus === "blocked" ? { question: report.question, updatedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }) });
	await writeJsonAtomic(join(run.recordDirectory, "run.json"), runRecord);
	if (report.status !== "needs-input") {
		if (await herdr.isTabFocused(tab.tabId)) void herdr.waitForTabUnfocused(tab.tabId).then(() => herdr.closeTab(tab.tabId)).catch(() => undefined);
		else await herdr.closeTab(tab.tabId);
	}
	return { runId, status, summary: report.summary, documents: report.documents ?? [], tabId: tab.tabId, paneId: tab.paneId, sessionFile: historical.sessionFile };
}
