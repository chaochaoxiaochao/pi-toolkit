import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { ensureRuntimeIgnored } from "./history.ts";
import { writeJsonAtomic } from "./state.ts";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const TASK_DIRECTORY_ENV = "PI_TINY_SUBAGENT_TASK_DIR";

export interface TinySubagentDocument {
	path: string;
	description: string;
}

export interface TinySubagentReport {
	status: "completed" | "needs-input" | "failed";
	summary: string;
	documents: TinySubagentDocument[];
	error?: string;
	question?: string;
	reportedAt?: string;
}

export interface TinySubagentOptions {
	agent?: string;
	label?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	access?: "read" | "write";
	systemPrompt?: string;
	cwd?: string;
	signal?: AbortSignal;
	herdr?: HerdrAutomation;
	onUpdate?: (result: TinySubagentResult) => void;
}

export interface TinySubagentResult {
	ok: boolean;
	status: "starting" | "running" | "blocked" | "completed" | "failed";
	summary: string;
	documents: TinySubagentDocument[];
	output: string;
	errorMessage?: string;
	runId?: string;
	taskId?: string;
	tabId?: string;
	paneId?: string;
	sessionFile?: string;
	recordDirectory?: string;
	model?: string;
	cwd: string;
	durationMs: number;
}

interface RunRecord {
	id: string;
	label: string;
	status: "starting" | "running" | "blocked" | "completed" | "failed";
	cwd: string;
	taskIds: string[];
	startedAt: string;
	completedAt?: string;
	tabId?: string;
	paneId?: string;
	error?: string;
}

interface TaskRecord {
	id: string;
	runId: string;
	status: "starting" | "running" | "blocked" | "completed" | "failed";
	prompt: string;
	agent: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	access?: "read" | "write";
	systemPrompt: string;
	sessionFile: string;
	startedAt: string;
	completedAt?: string;
	tabId?: string;
	paneId?: string;
	error?: string;
}

function compactText(report: TinySubagentReport): string {
	const lines = [report.summary];
	if (report.documents.length > 0) {
		lines.push("", "Documents:", ...report.documents.map((document) => `- ${document.description}: ${document.path}`));
	}
	if (report.error) lines.push("", `Error: ${report.error}`);
	return lines.join("\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<TinySubagentResult> = {}): TinySubagentResult {
	return {
		ok: false,
		status: "failed",
		summary: "Tiny subagent failed.",
		documents: [],
		output: `Tiny subagent failed.\nError: ${errorMessage}`,
		errorMessage,
		cwd,
		durationMs: Date.now() - startedAt,
		...fields,
	};
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeJsonAtomic(path, value);
}

function validReport(value: unknown): value is TinySubagentReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	if (report.status !== "completed" && report.status !== "needs-input" && report.status !== "failed") return false;
	if (typeof report.summary !== "string" || !report.summary.trim()) return false;
	if (!Array.isArray(report.documents)) return false;
	return report.documents.every((document) => {
		if (!document || typeof document !== "object") return false;
		const entry = document as Record<string, unknown>;
		return typeof entry.path === "string" && typeof entry.description === "string";
	});
}

async function readReport(path: string): Promise<TinySubagentReport | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return validReport(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function protocolPrompt(systemPrompt: string): string {
	return [
		systemPrompt.trim(),
		"",
		"When the task is finished, call subagent_report exactly once.",
		"Put the complete final answer in result, a concise parent-facing paragraph in summary, and list any useful document paths.",
		"Use status=needs-input with question when missing information prevents progress, or status=failed with an error when the task cannot be completed.",
	].join("\n").trim();
}

export async function runTinySubagent(prompt: string, options: TinySubagentOptions = {}): Promise<TinySubagentResult> {
	const startedAt = Date.now();
	const cwd = options.cwd ?? process.cwd();
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
		return failure(cwd, startedAt, "Tiny subagents must run from a Pi session inside Herdr.");
	}

	const runId = randomUUID();
	const taskId = randomUUID();
	const agent = options.agent?.trim() || "worker";
	const label = options.label?.trim() || agent;
	const runDirectory = join(cwd, ".pi", "herdr-subagents", "runs", `${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z-")}${runId.slice(0, 8)}`);
	const taskDirectory = join(runDirectory, "tasks", `01-${taskId.slice(0, 8)}`);
	const sessionFile = join(taskDirectory, "session.jsonl");
	const systemPromptFile = join(taskDirectory, "system-prompt.md");
	const reportFile = join(taskDirectory, "report.json");
	const runFile = join(runDirectory, "run.json");
	const taskFile = join(taskDirectory, "task.json");
	const helperExtension = fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url));
	const startedAtIso = new Date(startedAt).toISOString();
	const systemPrompt = protocolPrompt(options.systemPrompt ?? "You are a focused worker subagent.");
	const runRecord: RunRecord = {
		id: runId,
		label,
		status: "starting",
		cwd,
		taskIds: [taskId],
		startedAt: startedAtIso,
	};
	const taskRecord: TaskRecord = {
		id: taskId,
		runId,
		status: "starting",
		prompt,
		agent,
		...(options.model ? { model: options.model } : {}),
		...(options.thinking ? { thinking: options.thinking } : {}),
		...(options.tools ? { tools: options.tools } : {}),
		...(options.skills ? { skills: options.skills } : {}),
		...(options.access ? { access: options.access } : {}),
		systemPrompt,
		sessionFile,
		startedAt: startedAtIso,
	};
	await ensureRuntimeIgnored(cwd);
	await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
	await writeFile(systemPromptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });
	await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);

	const herdr = options.herdr ?? new CliHerdrAutomation();
	let tabId: string | undefined;
	let paneId: string | undefined;
	let result: TinySubagentResult | undefined;
	const common = (): Partial<TinySubagentResult> => ({
		runId,
		taskId,
		...(tabId ? { tabId } : {}),
		...(paneId ? { paneId } : {}),
		sessionFile,
		recordDirectory: taskDirectory,
		...(options.model ? { model: options.model } : {}),
	});
	const update = (status: TinySubagentResult["status"], summary: string) => {
		options.onUpdate?.({
			ok: false,
			status,
			summary,
			documents: [],
			output: summary,
			cwd,
			durationMs: Date.now() - startedAt,
			...common(),
		});
	};
	update("starting", "Creating Herdr tab...");

	try {
		const tab = await retryBeforePrompt(() => herdr.createTab({
			workspaceId: process.env.HERDR_WORKSPACE_ID,
			cwd,
			label: `SA · ${label}`,
			env: {
				[CHILD_ENV]: "1",
				[TASK_DIRECTORY_ENV]: taskDirectory,
			},
			focus: false,
			signal: options.signal,
		}));
		tabId = tab.tabId;
		paneId = tab.paneId;
		Object.assign(runRecord, { status: "running", tabId, paneId });
		Object.assign(taskRecord, { status: "running", tabId, paneId });
		await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);

		const childArgs = [
			"--approve",
			"--session", sessionFile,
			"--name", `Subagent: ${label}`,
			"--no-extensions",
			"--extension", helperExtension,
			"--no-skills",
			"--append-system-prompt", systemPromptFile,
		];
		if (options.model?.trim()) childArgs.push("--model", options.model.trim());
		if (options.thinking?.trim()) childArgs.push("--thinking", options.thinking.trim());
		if (options.tools?.length) {
			childArgs.push("--tools", [...new Set([...options.tools, "subagent_report"])].join(","));
		}
		for (const skill of options.skills ?? []) childArgs.push("--skill", skill);
		const name = `tiny-${taskId.replace(/-/g, "").slice(0, 12)}`;
		update("starting", "Starting child Pi in Herdr...");
		await retryBeforePrompt(() => herdr.startAgent({ name, kind: "pi", paneId, args: childArgs, signal: options.signal }));
		update("running", "Child Pi is working...");
		await herdr.promptAgent({ target: name, prompt, signal: options.signal });

		const report = await readReport(reportFile);
		if (!report) throw new Error("Child Pi settled but did not submit a valid subagent_report.");
		const completedAt = new Date().toISOString();
		const settledStatus = report.status === "needs-input" ? "blocked" : report.status;
		Object.assign(runRecord, {
			status: settledStatus,
			completedAt,
			...(report.error ? { error: report.error } : {}),
			...(report.question ? { question: report.question } : {}),
		});
		Object.assign(taskRecord, {
			status: settledStatus,
			completedAt,
			...(report.error ? { error: report.error } : {}),
			...(report.question ? { question: report.question } : {}),
		});
		await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);
		result = {
			ok: report.status === "completed",
			status: settledStatus,
			summary: report.summary,
			documents: report.documents,
			output: compactText(report),
			...(report.error || report.question ? { errorMessage: report.error ?? report.question } : {}),
			cwd,
			durationMs: Date.now() - startedAt,
			...common(),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const completedAt = new Date().toISOString();
		Object.assign(runRecord, { status: "failed", completedAt, error: errorMessage });
		Object.assign(taskRecord, { status: "failed", completedAt, error: errorMessage });
		await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);
		if (!existsSync(reportFile)) {
			await writeJson(reportFile, { status: "failed", summary: "Tiny subagent failed.", documents: [], error: errorMessage, reportedAt: completedAt });
		}
		result = failure(cwd, startedAt, errorMessage, common());
	} finally {
		if (tabId && result?.status !== "blocked") {
			try {
				const cleanupSignal = options.signal?.aborted ? undefined : options.signal;
				if (await herdr.isTabFocused(tabId, cleanupSignal)) void herdr.waitForTabUnfocused(tabId, cleanupSignal).then(() => herdr.closeTab(tabId as string, cleanupSignal)).catch(() => undefined);
				else await herdr.closeTab(tabId, cleanupSignal);
			} catch (error) {
				const cleanupError = error instanceof Error ? error.message : String(error);
				if (result?.ok) {
					const errorMessage = `Task completed but Herdr tab cleanup failed: ${cleanupError}`;
					const completedAt = new Date().toISOString();
					Object.assign(runRecord, { status: "failed", completedAt, error: errorMessage });
					Object.assign(taskRecord, { status: "failed", completedAt, error: errorMessage });
					await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);
					result = failure(cwd, startedAt, errorMessage, common());
				}
			}
		}
	}

	return result ?? failure(cwd, startedAt, "Tiny subagent ended without a result.", common());
}
