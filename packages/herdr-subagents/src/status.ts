import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadQueuedRuns } from "./queued-runs.ts";
import { isSettledRunStatus, readReport, readRunRecord, readTaskRecord, type RunStatus, type TaskStatus } from "./records.ts";
import { findRunDirectory, resolveRunIdReference } from "./run-locator.ts";

export interface RunStatusTask {
	order: number;
	name: string;
	agent: string;
	status: TaskStatus;
	summary?: string;
	question?: string;
	error?: string;
	failureKind?: "missing_input";
	requiredInput?: string;
}

export interface RunStatusSnapshot {
	runId: string;
	label: string;
	status: RunStatus;
	settled: boolean;
	source: "run" | "queue";
	queuedAt?: string;
	startedAt?: string;
	updatedAt?: string;
	completedAt?: string;
	question?: string;
	error?: string;
	tasks: RunStatusTask[];
}

async function loadDurableStatus(cwd: string, runId: string): Promise<RunStatusSnapshot | undefined> {
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	const runDirectory = await findRunDirectory(runsDirectory, runId);
	if (!runDirectory) return undefined;
	const run = await readRunRecord(join(runDirectory, "run.json"));
	const tasksDirectory = join(runDirectory, "tasks");
	const tasks: RunStatusTask[] = [];
	if (existsSync(tasksDirectory)) for (const entry of readdirSync(tasksDirectory).sort()) {
		const taskDirectory = join(tasksDirectory, entry);
		const task = await readTaskRecord(join(taskDirectory, "task.json"));
		const reportFile = join(taskDirectory, "report.json");
		const reportIsCurrent = task.status === "blocked" || isSettledRunStatus(task.status);
		const report = reportIsCurrent && existsSync(reportFile) ? await readReport(reportFile) : undefined;
		const question = report?.question ?? task.question;
		const error = report?.error ?? task.error;
		const failureKind = report?.failureKind ?? task.failureKind;
		const requiredInput = report?.requiredInput ?? task.requiredInput;
		tasks.push({
			order: task.order,
			name: task.name ?? task.agent ?? `Task ${task.order}`,
			agent: task.agent ?? "worker",
			status: task.status,
			...(report?.summary ? { summary: report.summary } : {}),
			...(question ? { question } : {}),
			...(error ? { error } : {}),
			...(failureKind ? { failureKind } : {}),
			...(requiredInput ? { requiredInput } : {}),
		});
	}
	return {
		runId: run.id,
		label: run.label,
		status: run.status,
		settled: isSettledRunStatus(run.status),
		source: "run",
		...(run.startedAt ? { startedAt: run.startedAt } : {}),
		...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
		...(run.completedAt ? { completedAt: run.completedAt } : {}),
		...(run.question ? { question: run.question } : {}),
		...(run.error ? { error: run.error } : {}),
		tasks: tasks.sort((left, right) => left.order - right.order),
	};
}

export async function getSubagentRunStatus(cwd: string, runId: string): Promise<RunStatusSnapshot | undefined> {
	const queuedRuns = await loadQueuedRuns(cwd);
	const durable = await loadDurableStatus(cwd, runId);
	if (durable) {
		resolveRunIdReference(runId, [durable.runId, ...queuedRuns.map((candidate) => candidate.runId)]);
		return durable;
	}
	const queuedId = resolveRunIdReference(runId, queuedRuns.map((candidate) => candidate.runId));
	const queued = queuedRuns.find((candidate) => candidate.runId === queuedId);
	if (!queued) return undefined;
	return {
		runId: queued.runId,
		label: queued.params.label ?? "batch",
		status: "queued",
		settled: false,
		source: "queue",
		queuedAt: queued.queuedAt,
		tasks: queued.params.tasks.map((task, index) => ({ order: index + 1, name: task.name, agent: task.agent ?? "worker", status: "queued" })),
	};
}

export function runStatusText(status: RunStatusSnapshot): string {
	const lines = [`${status.runId} · ${status.label} · ${status.status} · ${status.tasks.length} tasks`];
	for (const task of status.tasks) {
		const detail = task.question ? ` — ${task.question}` : task.summary ? ` — ${task.summary}` : task.error ? ` — ${task.error}` : "";
		lines.push(`  ${task.order}. ${task.name}: ${task.status}${detail}`);
	}
	return lines.join("\n");
}
