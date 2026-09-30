import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHerdrAutomation, retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import { ensureRuntimeIgnored } from "./history.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import type { OwnerIdentity } from "./ownership.ts";
import { ownerRecord } from "./ownership.ts";

const CHILD_ENV = "PI_HERDR_SUBAGENTS_CHILD";
const TASK_DIRECTORY_ENV = "PI_HERDR_SUBAGENTS_TASK_DIR";

export interface HerdrSubagentsDocument {
	path: string;
	description: string;
}

export interface HerdrSubagentsReport {
	status: "completed" | "needs-input" | "failed";
	summary: string;
	documents: HerdrSubagentsDocument[];
	error?: string;
	question?: string;
	reportedAt?: string;
}

export interface HerdrSubagentsOptions {
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
	owner?: OwnerIdentity;
	onUpdate?: (result: HerdrSubagentsResult) => void;
	onCleanupError?: (message: string) => void;
}

export interface HerdrSubagentsResult {
	ok: boolean;
	status: "starting" | "running" | "blocked" | "completed" | "failed" | "cancelled";
	summary: string;
	documents: HerdrSubagentsDocument[];
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
	status: "starting" | "running" | "blocked" | "completed" | "failed" | "cancelled";
	cwd: string;
	ownerSessionId?: string;
	ownerProcessId?: number;
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
	order: number;
	name: string;
	status: "starting" | "running" | "blocked" | "completed" | "failed" | "cancelled";
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
	paneLabel?: string;
	agentName?: string;
	error?: string;
}

function compactText(report: HerdrSubagentsReport): string {
	const lines = [report.summary];
	if (report.documents.length > 0) {
		lines.push("", "Documents:", ...report.documents.map((document) => `- ${document.description}: ${document.path}`));
	}
	if (report.error) lines.push("", `Error: ${report.error}`);
	return lines.join("\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<HerdrSubagentsResult> = {}): HerdrSubagentsResult {
	return {
		ok: false,
		status: "failed",
		summary: "Herdr Subagents failed.",
		documents: [],
		output: `Herdr Subagents failed.\nError: ${errorMessage}`,
		errorMessage,
		cwd,
		durationMs: Date.now() - startedAt,
		...fields,
	};
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeJsonAtomic(path, value);
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

export async function runHerdrSubagents(prompt: string, options: HerdrSubagentsOptions = {}): Promise<HerdrSubagentsResult> {
	const startedAt = Date.now();
	const cwd = options.cwd ?? process.cwd();
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
		return failure(cwd, startedAt, "Herdr Subagents must run from a Pi session inside Herdr.");
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
	const startedAtIso = new Date(startedAt).toISOString();
	const systemPrompt = protocolPrompt(options.systemPrompt ?? "You are a focused worker subagent.");
	const runRecord: RunRecord = {
		id: runId,
		label,
		status: "starting",
		cwd,
		...ownerRecord(options.owner),
		taskIds: [taskId],
		startedAt: startedAtIso,
	};
	const taskRecord: TaskRecord = {
		id: taskId,
		runId,
		order: 1,
		name: label,
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
	let result: HerdrSubagentsResult | undefined;
	const common = (): Partial<HerdrSubagentsResult> => ({
		runId,
		taskId,
		...(tabId ? { tabId } : {}),
		...(paneId ? { paneId } : {}),
		sessionFile,
		recordDirectory: taskDirectory,
		...(options.model ? { model: options.model } : {}),
	});
	const update = (status: HerdrSubagentsResult["status"], summary: string) => {
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
		const paneLabel = `01 · ${label}`;
		await herdr.renamePane(paneId, paneLabel, options.signal);
		Object.assign(runRecord, { status: "running", tabId, paneId });
		Object.assign(taskRecord, { status: "running", tabId, paneId, paneLabel });
		await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);

		const name = liveAgentName(taskId);
		taskRecord.agentName = name;
		await writeJson(taskFile, taskRecord);
		update("starting", "Starting child Pi in Herdr...");
		update("running", "Child Pi is working...");
		const { report } = await promptLiveAgent({ herdr, task: { ...taskRecord, id: taskId, sessionFile }, paneId, prompt, systemPromptFile, agentName: name, signal: options.signal });
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
		const cancelled = options.signal?.aborted === true;
		const completedAt = new Date().toISOString();
		Object.assign(runRecord, { status: cancelled ? "cancelled" : "failed", completedAt, error: errorMessage });
		Object.assign(taskRecord, { status: cancelled ? "cancelled" : "failed", completedAt, error: errorMessage });
		await Promise.all([writeJson(runFile, runRecord), writeJson(taskFile, taskRecord)]);
		if (!existsSync(reportFile)) {
			await writeJson(reportFile, { status: "failed", summary: "Herdr Subagents failed.", documents: [], error: errorMessage, reportedAt: completedAt });
		}
		result = cancelled
			? { ...failure(cwd, startedAt, errorMessage, common()), status: "cancelled", summary: "Herdr Subagents cancelled.", output: `Herdr Subagents cancelled.\nError: ${errorMessage}` }
			: failure(cwd, startedAt, errorMessage, common());
	} finally {
		if (tabId && result?.status !== "blocked") {
			try {
				const cleanupSignal = options.signal?.aborted ? undefined : options.signal;
				await cleanupRunTab({ herdr, tabId, runFile, runRecord, signal: cleanupSignal, onError: options.onCleanupError });
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

	return result ?? failure(cwd, startedAt, "Herdr Subagents ended without a result.", common());
}
