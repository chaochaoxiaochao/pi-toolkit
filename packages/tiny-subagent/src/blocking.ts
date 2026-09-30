import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
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

export async function respondToBlockedTask(cwd: string, runId: string, answer: string, herdr: HerdrAutomation = new CliHerdrAutomation(), taskNumber?: number): Promise<ResumeBlockedResult> {
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
	const reportFile = join(taskDirectory, "report.json");
	await rm(reportFile, { force: true });
	const resumePrompt = join(taskDirectory, "resume-system-prompt.md");
	await writeTextAtomic(resumePrompt, "This is a new resumed turn. When this turn is finished, call subagent_report exactly once for this turn, even if an earlier turn already used it.\n");
	const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", task.sessionFile, "--name", `Subagent: ${task.name ?? task.agent}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", resumePrompt];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (Array.isArray(task.tools) && task.tools.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
	for (const skill of task.skills ?? []) args.push("--skill", skill);
	await retryBeforePrompt(() => herdr.prepareTask(args));
	await herdr.runTask({ paneId: task.paneId, args, prompt: answer, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: taskDirectory }, marker: `PI_SUBAGENT_RESUMED_${task.id.replace(/-/g, "")}` });
	if (!existsSync(reportFile)) throw new Error("Resumed child Pi did not submit a subagent_report.");
	const report = await readJson(reportFile) as unknown as TinySubagentReport;
	if (report.status !== "completed" && report.status !== "needs-input" && report.status !== "failed") throw new Error("Resumed child Pi submitted an invalid subagent_report.");
	const status = report.status === "needs-input" ? "blocked" : report.status;
	Object.assign(task, { status, completedAt: new Date().toISOString(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
	await writeJson(join(taskDirectory, "task.json"), task);
	if (status !== "blocked") {
		for (const directory of taskDirectories) {
			const queuedFile = join(directory, "task.json");
			const queued = await readJson(queuedFile);
			if (queued.status !== "queued") continue;
			const queuedReportFile = join(directory, "report.json");
			const queuedArgs = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", queued.sessionFile, "--name", `Subagent: ${queued.name ?? queued.agent}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", join(directory, "system-prompt.md")];
			if (queued.model) queuedArgs.push("--model", queued.model);
			if (queued.thinking) queuedArgs.push("--thinking", queued.thinking);
			if (Array.isArray(queued.tools) && queued.tools.length) queuedArgs.push("--tools", [...new Set([...queued.tools, "subagent_report"])].join(","));
			for (const skill of queued.skills ?? []) queuedArgs.push("--skill", skill);
			Object.assign(queued, { status: "running", paneId: task.paneId, startedAt: new Date().toISOString() });
			await writeJson(queuedFile, queued);
			await herdr.renamePane(task.paneId, `${queued.order}. ${queued.name ?? queued.agent}`);
			try {
				await retryBeforePrompt(() => herdr.prepareTask(queuedArgs));
				await herdr.runTask({ paneId: task.paneId, args: queuedArgs, prompt: queued.prompt, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: directory }, marker: `PI_SUBAGENT_CONTINUE_${queued.id.replace(/-/g, "")}` });
				const queuedReport = await readJson(queuedReportFile) as unknown as TinySubagentReport;
				const queuedStatus = queuedReport.status === "needs-input" ? "blocked" : queuedReport.status;
				Object.assign(queued, { status: queuedStatus, completedAt: new Date().toISOString(), ...(queuedReport.error ? { error: queuedReport.error } : {}), ...(queuedReport.question ? { question: queuedReport.question } : {}) });
				await writeJson(queuedFile, queued);
				if (queuedStatus === "blocked") break;
			} catch (error) {
				Object.assign(queued, { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
				await writeJson(queuedFile, queued);
			}
		}
	}
	const finalTasks = await Promise.all(taskDirectories.map((directory) => readJson(join(directory, "task.json"))));
	const finalReports = await Promise.all(taskDirectories.map(async (directory) => {
		try { return await readJson(join(directory, "report.json")); }
		catch { return { status: "failed", summary: "Task failed without a structured report.", documents: [] }; }
	}));
	const statuses = finalTasks.map((entry) => entry.status);
	const runStatus = statuses.some((value) => value === "blocked" || value === "queued" || value === "running") ? "blocked" : statuses.some((value) => value === "failed") ? (statuses.some((value) => value === "completed") ? "partial" : "failed") : "completed";
	const blockedIndex = finalTasks.findIndex((entry) => entry.status === "blocked");
	const currentBlockedReport = blockedIndex >= 0 ? finalReports[blockedIndex] : undefined;
	Object.assign(run, { status: runStatus, ...(runStatus === "blocked" ? { question: currentBlockedReport?.question, updatedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }) });
	await writeJson(runFile, run);
	if (runStatus !== "blocked" && run.tabId) {
		if (await herdr.isTabFocused(run.tabId)) void herdr.waitForTabUnfocused(run.tabId).then(() => herdr.closeTab(run.tabId)).catch(() => undefined);
		else await herdr.closeTab(run.tabId);
	}
	const summary = runStatus === "completed" ? "All tasks completed after the answer." : runStatus === "blocked" ? `${finalTasks[blockedIndex]?.name ?? "Task"} needs input: ${currentBlockedReport?.question ?? "Input required."}` : finalReports.map((entry, index) => `${finalTasks[index].name}: ${entry.summary}`).join("\n");
	const documents = finalReports.flatMap((entry) => entry.documents ?? []);
	return { runId, status: runStatus === "partial" ? "failed" : runStatus, summary, ...(currentBlockedReport?.question ? { question: currentBlockedReport.question } : {}), documents, recordDirectory: taskDirectory };
}
