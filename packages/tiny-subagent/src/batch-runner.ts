import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import type { PersonaAccess } from "./config.ts";
import type { TinySubagentDocument, TinySubagentReport } from "./runner.ts";
import { ensureRuntimeIgnored } from "./history.ts";

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
	cwd: string;
	signal?: AbortSignal;
	herdr?: HerdrAutomation;
	onUpdate?: (result: BatchResult) => void;
}

export interface BatchTaskResult {
	index: number;
	name: string;
	status: "completed" | "blocked" | "failed";
	summary: string;
	documents: TinySubagentDocument[];
	error?: string;
	question?: string;
	paneId: string;
	recordDirectory: string;
	sessionFile: string;
}

export interface BatchResult {
	ok: boolean;
	status: "starting" | "running" | "blocked" | "completed" | "partial" | "failed";
	runId: string;
	label: string;
	requestedConcurrency: number;
	effectiveConcurrency: number;
	tasks: BatchTaskResult[];
	activity: Array<{ index: number; name: string; status: "queued" | "running" | "blocked" | "completed" | "failed"; paneId?: string }>;
	summary: string;
	documents: TinySubagentDocument[];
	recordDirectory: string;
	tabId?: string;
}

function timestamp(): string { return new Date().toISOString(); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
function validReport(value: unknown): value is TinySubagentReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	return (report.status === "completed" || report.status === "needs-input" || report.status === "failed") && typeof report.summary === "string" && Array.isArray(report.documents) && (report.status !== "needs-input" || typeof report.question === "string");
}
function protocolPrompt(systemPrompt: string): string {
	return `${systemPrompt.trim()}\n\nWhen the task is finished, call subagent_report exactly once. Put the complete final answer in result, a concise parent-facing paragraph in summary, and list any useful document paths. Use status=needs-input with question when missing information prevents progress, or status=failed with an error when the task cannot be completed.`;
}

export async function runTinySubagentBatch(tasks: BatchTask[], options: BatchOptions): Promise<BatchResult> {
	if (!tasks.length) throw new Error("At least one task is required.");
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new Error("Tiny subagents must run from a Pi session inside Herdr.");
	const runId = options.runId ?? randomUUID();
	const requestedConcurrency = Math.max(1, Math.floor(options.concurrency));
	const hasWriter = tasks.some((task) => task.access === "write");
	const effectiveConcurrency = hasWriter ? 1 : Math.min(requestedConcurrency, options.maxConcurrency, tasks.length);
	const runDirectory = join(options.cwd, ".pi", "herdr-subagents", "runs", `${timestamp().replace(/[-:.]/g, "").replace("Z", "Z-")}${runId.slice(0, 8)}`);
	const runFile = join(runDirectory, "run.json");
	await ensureRuntimeIgnored(options.cwd);
	await mkdir(join(runDirectory, "tasks"), { recursive: true, mode: 0o700 });
	const runRecord: Record<string, unknown> = { id: runId, label: options.label, status: "starting", cwd: options.cwd, requestedConcurrency, effectiveConcurrency, startedAt: timestamp(), taskIds: [] };
	await writeJson(runFile, runRecord);
	const herdr = options.herdr ?? new CliHerdrAutomation();
	let tabId: string | undefined;
	let keepTab = false;
	const results = new Array<BatchTaskResult>(tasks.length);
	const activity: BatchResult["activity"] = tasks.map((task, index) => ({ index, name: task.name, status: "queued" }));
	const emit = (status: BatchResult["status"], summary: string) => options.onUpdate?.({ ok: false, status, runId, label: options.label, requestedConcurrency, effectiveConcurrency, tasks: results.filter(Boolean), activity: activity.map((task) => ({ ...task })), summary, documents: [], recordDirectory: runDirectory, tabId });
	emit("starting", `Creating ${effectiveConcurrency} Herdr worker slot${effectiveConcurrency === 1 ? "" : "s"}...`);
	try {
		const tab = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID, cwd: options.cwd, label: `SA · ${options.label} · 0/${tasks.length}`, env: { PI_SUBAGENT_CHILD: "1" }, focus: false, signal: options.signal });
		tabId = tab.tabId;
		const panes = [tab.paneId];
		while (panes.length < effectiveConcurrency) {
			const split = await herdr.splitPane({ paneId: panes[panes.length - 1], cwd: options.cwd, direction: panes.length % 2 ? "right" : "down", focus: false, signal: options.signal });
			panes.push(split.paneId);
		}
		Object.assign(runRecord, { status: "running", tabId, paneIds: panes });
		await writeJson(runFile, runRecord);
		let nextIndex = 0;
		let settled = 0;
		let blockedDetected = false;
		const startResolvers: Array<() => void> = [];
		const started = tasks.map((_, index) => new Promise<void>((resolve) => { startResolvers[index] = resolve; }));
		const runOne = async (index: number, paneId: string): Promise<void> => {
			const task = tasks[index];
			const taskId = randomUUID();
			(runRecord.taskIds as string[]).push(taskId);
			const taskDirectory = join(runDirectory, "tasks", `${String(index + 1).padStart(2, "0")}-${taskId.slice(0, 8)}`);
			const sessionFile = join(taskDirectory, "session.jsonl");
			const reportFile = join(taskDirectory, "report.json");
			const taskFile = join(taskDirectory, "task.json");
			const systemPromptFile = join(taskDirectory, "system-prompt.md");
			const systemPrompt = protocolPrompt(task.systemPrompt);
			await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
			await writeFile(systemPromptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });
			const taskRecord: Record<string, unknown> = { id: taskId, runId, order: index + 1, name: task.name, status: "running", prompt: task.prompt, agent: task.agent, access: task.access, model: task.model, thinking: task.thinking, tools: task.tools, skills: task.skills, systemPrompt, sessionFile, paneId, startedAt: timestamp() };
			await writeJson(taskFile, taskRecord);
			activity[index] = { index, name: task.name, status: "running", paneId };
			await herdr.renamePane(paneId, `${index + 1}. ${task.name}`, options.signal);
			emit("running", `${settled}/${tasks.length} tasks settled.`);
			const args = [process.env.PI_TINY_SUBAGENT_PI_BINARY?.trim() || "pi", "--approve", "--print", "--session", sessionFile, "--name", `Subagent: ${task.name}`, "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)), "--no-skills", "--append-system-prompt", systemPromptFile];
			if (task.model) args.push("--model", task.model);
			if (task.thinking) args.push("--thinking", task.thinking);
			if (task.tools?.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
			for (const skill of task.skills) args.push("--skill", skill);
			let report: TinySubagentReport;
			try {
				if (index > 0) await started[index - 1];
				const running = herdr.runTask({ paneId, args, prompt: task.prompt, env: { PI_SUBAGENT_CHILD: "1", PI_TINY_SUBAGENT_TASK_DIR: taskDirectory }, marker: `PI_SUBAGENT_DONE_${taskId.replace(/-/g, "")}`, signal: options.signal });
				startResolvers[index]();
				await running;
				if (!existsSync(reportFile)) throw new Error("Child Pi settled but did not submit a subagent_report.");
				const value = JSON.parse(await readFile(reportFile, "utf8")) as unknown;
				if (!validReport(value)) throw new Error("Child Pi submitted an invalid subagent_report.");
				report = value;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				report = { status: "failed", summary: `${task.name} failed.`, documents: [], error: message, reportedAt: timestamp() };
				if (!existsSync(reportFile)) await writeJson(reportFile, report);
			}
			const taskStatus = report.status === "needs-input" ? "blocked" : report.status;
			if (taskStatus === "blocked") blockedDetected = true;
			Object.assign(taskRecord, { status: taskStatus, completedAt: timestamp(), ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}) });
			await writeJson(taskFile, taskRecord);
			results[index] = { index, name: task.name, status: taskStatus, summary: report.summary, documents: report.documents, ...(report.error ? { error: report.error } : {}), ...(report.question ? { question: report.question } : {}), paneId, recordDirectory: taskDirectory, sessionFile };
			activity[index] = { index, name: task.name, status: taskStatus, paneId };
			settled += 1;
			await herdr.renameTab(tabId as string, `SA · ${options.label} · ${settled}/${tasks.length}`, options.signal);
			emit("running", `${settled}/${tasks.length} tasks settled.`);
		};
		const worker = async (paneId: string) => { while (true) { if (blockedDetected) return; const index = nextIndex++; if (index >= tasks.length) return; await runOne(index, paneId); } };
		await Promise.all(panes.map(worker));
		const settledResults = results.filter(Boolean);
		const failed = settledResults.filter((result) => result.status === "failed").length;
		const blocked = settledResults.find((result) => result.status === "blocked");
		const status = blocked ? "blocked" : failed === 0 ? "completed" : failed === tasks.length ? "failed" : "partial";
		keepTab = status === "blocked";
		Object.assign(runRecord, { status, ...(blocked ? { question: blocked.question, updatedAt: timestamp() } : { completedAt: timestamp() }) });
		await writeJson(runFile, runRecord);
		const documents = settledResults.flatMap((result) => result.documents);
		const summary = blocked ? `${blocked.name} needs input: ${blocked.question}` : failed ? `${tasks.length - failed}/${tasks.length} tasks completed; ${failed} failed.` : `${tasks.length}/${tasks.length} tasks completed.`;
		return { ok: status === "completed", status, runId, label: options.label, requestedConcurrency, effectiveConcurrency, tasks: settledResults, activity, summary, documents, recordDirectory: runDirectory, tabId };
	} finally {
		if (tabId && !keepTab) {
			const cleanupSignal = options.signal?.aborted ? undefined : options.signal;
			if (await herdr.isTabFocused(tabId, cleanupSignal)) {
				void herdr.waitForTabUnfocused(tabId, cleanupSignal).then(() => herdr.closeTab(tabId as string, cleanupSignal)).catch(() => undefined);
			} else await herdr.closeTab(tabId, cleanupSignal);
		}
	}
}
