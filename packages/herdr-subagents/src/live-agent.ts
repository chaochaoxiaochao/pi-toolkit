import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retryBeforePrompt, type HerdrAutomation } from "./herdr.ts";
import type { HerdrSubagentsReport } from "./runner.ts";

export interface LiveTaskRecord {
	id: string;
	name?: string;
	agent?: string;
	sessionFile: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
}

export function childPiArgs(task: LiveTaskRecord, systemPromptFile: string): string[] {
	const args = [
		"--approve",
		"--session", task.sessionFile,
		"--name", `Subagent: ${task.name ?? task.agent ?? "worker"}`,
		"--no-extensions",
		"--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)),
		"--no-skills",
		"--append-system-prompt", systemPromptFile,
	];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (task.tools?.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
	for (const skill of task.skills ?? []) args.push("--skill", skill);
	return args;
}

export function liveAgentName(taskId: string, attempt = 1): string {
	return `herdr-subagent-${taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-${attempt}`;
}

function validReport(value: unknown): value is HerdrSubagentsReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	return (report.status === "completed" || report.status === "needs-input" || report.status === "failed")
		&& typeof report.summary === "string" && report.summary.trim().length > 0
		&& Array.isArray(report.documents) && report.documents.every((document) => {
			if (!document || typeof document !== "object") return false;
			const entry = document as Record<string, unknown>;
			return typeof entry.path === "string" && typeof entry.description === "string";
		})
		&& (report.status !== "needs-input" || typeof report.question === "string");
}

export async function promptLiveAgent(options: {
	herdr: HerdrAutomation;
	task: LiveTaskRecord;
	paneId: string;
	prompt: string;
	systemPromptFile: string;
	agentName?: string;
	attempt?: number;
	signal?: AbortSignal;
	start?: boolean;
	stalledWarningMs?: number;
	onStalled?: () => void;
}): Promise<{ report: HerdrSubagentsReport; agentName: string }> {
	const taskDirectory = dirname(options.task.sessionFile);
	const reportFile = join(taskDirectory, "report.json");
	await rm(reportFile, { force: true });
	const agentName = options.agentName ?? liveAgentName(options.task.id, options.attempt);
	if (options.start !== false) {
		await retryBeforePrompt(() => options.herdr.startAgent({
			name: agentName,
			kind: "pi",
			paneId: options.paneId,
			args: childPiArgs(options.task, options.systemPromptFile),
			signal: options.signal,
		}));
	}
	const stalledTimer = options.stalledWarningMs ? setTimeout(() => options.onStalled?.(), options.stalledWarningMs) : undefined;
	try { await options.herdr.promptAgent({ target: agentName, prompt: options.prompt, signal: options.signal }); }
	finally { if (stalledTimer) clearTimeout(stalledTimer); }
	if (!existsSync(reportFile)) throw new Error("Child Pi settled but did not submit a subagent_report.");
	let value: unknown;
	try { value = JSON.parse(await readFile(reportFile, "utf8")); }
	catch { throw new Error("Child Pi submitted an invalid subagent_report."); }
	if (!validReport(value)) throw new Error("Child Pi submitted an invalid subagent_report.");
	return { report: value, agentName };
}
