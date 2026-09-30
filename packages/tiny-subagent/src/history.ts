import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";

export interface HistoricalTask { order: number; id: string; name: string; status: string; summary?: string; question?: string; recordDirectory: string; sessionFile: string; }
export interface HistoricalRun { id: string; label: string; status: string; startedAt: string; completedAt?: string; effectiveConcurrency?: number; tasks: HistoricalTask[]; recordDirectory: string; }

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

export async function ensureRuntimeIgnored(cwd: string): Promise<void> {
	const piDirectory = join(cwd, ".pi");
	const ignoreFile = join(piDirectory, ".gitignore");
	await mkdir(piDirectory, { recursive: true, mode: 0o700 });
	const line = "herdr-subagents/";
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
				tasks.push({ order: task.order ?? tasks.length + 1, id: task.id, name: task.name ?? task.agent, status: task.status, summary: report.summary, question: report.question, recordDirectory: taskDirectory, sessionFile: task.sessionFile });
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

export async function resumeHistoricalTask(cwd: string, runId: string, taskNumber: number, prompt: string, herdr: HerdrAutomation = new CliHerdrAutomation()): Promise<{ status: string; summary: string; documents: any[]; tabId: string; paneId: string; sessionFile: string }> {
	const run = (await listSubagentHistory(cwd)).find((candidate) => candidate.id === runId);
	const historical = run?.tasks.find((task) => task.order === taskNumber);
	if (!run || !historical) throw new Error(`Unknown historical task ${runId}#${taskNumber}.`);
	const followupDirectory = join(historical.recordDirectory, "followups", new Date().toISOString().replace(/[-:.]/g, ""));
	await mkdir(followupDirectory, { recursive: true, mode: 0o700 });
	const tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd, label: `SA · resume · ${historical.name}`, env: { PI_SUBAGENT_CHILD: "1" }, focus: false });
	const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", historical.sessionFile, "--name", `Subagent: ${historical.name}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills"];
	await herdr.runTask({ paneId: tab.paneId, args, prompt, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: followupDirectory }, marker: `PI_SUBAGENT_HISTORY_${Date.now()}` });
	const report = await readJson(join(followupDirectory, "report.json"));
	await writeFile(join(followupDirectory, "followup.json"), `${JSON.stringify({ prompt, sessionFile: historical.sessionFile, paneId: tab.paneId, reportedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (report.status !== "needs-input") {
		if (await herdr.isTabFocused(tab.tabId)) void herdr.waitForTabUnfocused(tab.tabId).then(() => herdr.closeTab(tab.tabId)).catch(() => undefined);
		else await herdr.closeTab(tab.tabId);
	}
	return { status: report.status === "needs-input" ? "blocked" : report.status, summary: report.summary, documents: report.documents ?? [], tabId: tab.tabId, paneId: tab.paneId, sessionFile: historical.sessionFile };
}
