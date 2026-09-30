import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic } from "./state.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

export async function continueQueuedRun(runDirectory: string, herdr: HerdrAutomation): Promise<void> {
	const runFile = join(runDirectory, "run.json");
	const run = await readJson(runFile);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	const queuedDirectories: string[] = [];
	for (const directory of taskDirectories) if ((await readJson(join(directory, "task.json"))).status === "queued") queuedDirectories.push(directory);
	let panes: string[] = [];
	for (const paneId of (run.paneIds as string[] | undefined) ?? []) if (await herdr.paneExists(paneId)) panes.push(paneId);
	if (!panes.length) {
		const tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd: run.cwd, label: `SA · ${run.label} · resume`, env: { PI_SUBAGENT_CHILD: "1" }, focus: false });
		run.tabId = tab.tabId;
		panes = [tab.paneId];
	}
	const concurrency = Math.max(1, Math.min(Number(run.effectiveConcurrency) || 1, queuedDirectories.length || 1));
	while (panes.length < concurrency) {
		const split = await herdr.splitPane({ paneId: panes[panes.length - 1], cwd: run.cwd, direction: panes.length % 2 ? "right" : "down", focus: false });
		panes.push(split.paneId);
	}
	run.paneIds = panes;
	run.status = "running";
	await writeJsonAtomic(runFile, run);
	let nextIndex = 0;
	let blocked = false;
	const runOne = async (directory: string, paneId: string) => {
		const taskFile = join(directory, "task.json");
		const task = await readJson(taskFile);
		const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", task.sessionFile, "--name", `Subagent: ${task.name ?? task.agent}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", join(directory, "system-prompt.md")];
		if (task.model) args.push("--model", task.model);
		if (task.thinking) args.push("--thinking", task.thinking);
		if (Array.isArray(task.tools) && task.tools.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
		for (const skill of task.skills ?? []) args.push("--skill", skill);
		Object.assign(task, { status: "running", paneId, startedAt: new Date().toISOString() });
		await writeJsonAtomic(taskFile, task);
		await herdr.renamePane(paneId, `${task.order}. ${task.name ?? task.agent}`);
		try {
			await retryBeforePrompt(() => herdr.prepareTask(args));
			await herdr.runTask({ paneId, args, prompt: task.prompt, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: directory }, marker: `PI_SUBAGENT_RECOVER_${task.id.replace(/-/g, "")}` });
			if (!existsSync(join(directory, "report.json"))) throw new Error("Recovered child did not submit a report.");
			const report = await readJson(join(directory, "report.json"));
			Object.assign(task, { status: report.status === "needs-input" ? "blocked" : report.status, completedAt: new Date().toISOString(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
		} catch (error) { Object.assign(task, { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }); }
		await writeJsonAtomic(taskFile, task);
		if (task.status === "blocked") blocked = true;
	};
	const worker = async (paneId: string) => { while (!blocked) { const index = nextIndex++; if (index >= queuedDirectories.length) return; await runOne(queuedDirectories[index], paneId); } };
	await Promise.all(panes.slice(0, concurrency).map(worker));
	const statuses = await Promise.all(taskDirectories.map(async (directory) => (await readJson(join(directory, "task.json"))).status as string));
	run.status = statuses.some((status) => status === "blocked" || status === "queued") ? "blocked" : statuses.some((status) => status === "failed" || status === "interrupted") ? (statuses.some((status) => status === "completed") ? "partial" : "failed") : "completed";
	run.completedAt = new Date().toISOString();
	await writeJsonAtomic(runFile, run);
	if (run.status !== "blocked" && run.tabId) {
		if (await herdr.isTabFocused(run.tabId)) void herdr.waitForTabUnfocused(run.tabId).then(() => herdr.closeTab(run.tabId)).catch(() => undefined);
		else await herdr.closeTab(run.tabId);
	}
}
