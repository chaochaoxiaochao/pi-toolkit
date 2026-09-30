import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import type { TinySubagentReport } from "./runner.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }
async function writeJson(path: string, value: unknown): Promise<void> { await writeJsonAtomic(path, value); }

export interface ResumeBlockedResult {
	runId: string;
	status: "blocked" | "completed" | "failed";
	summary: string;
	question?: string;
	documents: Array<{ path: string; description: string }>;
	recordDirectory: string;
}

export async function respondToBlockedTask(cwd: string, runId: string, answer: string, herdr: HerdrAutomation = new CliHerdrAutomation()): Promise<ResumeBlockedResult> {
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
		if (candidate.status === "blocked") { taskDirectory = directory; task = candidate; break; }
	}
	if (!taskDirectory || !task) throw new Error(`Run '${runId}' has no blocked task.`);
	const reportFile = join(taskDirectory, "report.json");
	await rm(reportFile, { force: true });
	const resumePrompt = join(taskDirectory, "resume-system-prompt.md");
	await writeTextAtomic(resumePrompt, "This is a new resumed turn. When this turn is finished, call subagent_report exactly once for this turn, even if an earlier turn already used it.\n");
	const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", task.sessionFile, "--name", `Subagent: ${task.name ?? task.agent}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", resumePrompt];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (Array.isArray(task.tools) && task.tools.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
	for (const skill of task.skills ?? []) args.push("--skill", skill);
	await herdr.runTask({ paneId: task.paneId, args, prompt: answer, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: taskDirectory }, marker: `PI_SUBAGENT_RESUMED_${task.id.replace(/-/g, "")}` });
	if (!existsSync(reportFile)) throw new Error("Resumed child Pi did not submit a subagent_report.");
	const report = await readJson(reportFile) as unknown as TinySubagentReport;
	if (report.status !== "completed" && report.status !== "needs-input" && report.status !== "failed") throw new Error("Resumed child Pi submitted an invalid subagent_report.");
	const status = report.status === "needs-input" ? "blocked" : report.status;
	Object.assign(task, { status, completedAt: new Date().toISOString(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
	await writeJson(join(taskDirectory, "task.json"), task);
	Object.assign(run, { status, ...(status === "blocked" ? { question: report.question, updatedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }) });
	await writeJson(runFile, run);
	if (status !== "blocked" && run.tabId) {
		if (await herdr.isTabFocused(run.tabId)) void herdr.waitForTabUnfocused(run.tabId).then(() => herdr.closeTab(run.tabId)).catch(() => undefined);
		else await herdr.closeTab(run.tabId);
	}
	return { runId, status, summary: report.summary, ...(report.question ? { question: report.question } : {}), documents: report.documents, recordDirectory: taskDirectory };
}
