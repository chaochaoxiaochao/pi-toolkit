import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { attemptReportPath, createAttemptId } from "./attempts.ts";
import { isAbortError } from "./errors.ts";
import { CliHerdrAutomation, type HerdrAutomation } from "./herdr.ts";
import { childEnvironment, liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { ownerRecord } from "./ownership.ts";
import { continuationSystemPrompt } from "./protocol.ts";
import { applyRunStatus } from "./run-status.ts";
import { acquireDirectoryLock, withRunStateLock } from "./run-state.ts";
import { applyReport, applyTaskStatus, isActiveStatus, readReport, readRunRecord, readTaskRecord, settleAttemptFailure, projectTaskActivity, type PersistedReport, type ResumeMember, type TaskRecord } from "./records.ts";
import { writeJsonAtomic, writeTextAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { findRunDirectory } from "./run-locator.ts";
import type { ResumeHistoricalTaskOptions, ResumeHistoricalTaskResult } from "./history.ts";
import { aggregateTasksWithResume, claimResumeCleanup, readTaskEntries } from "./resume-state.ts";

async function aggregateRun(runDirectory: string, active: Record<string, ResumeMember> = {}) {
	return aggregateTasksWithResume((await readTaskEntries(runDirectory)).map(({ task }) => task), active);
}

export async function resumeHistoricalTaskConcurrent(cwd: string, requestedRunId: string, taskNumber: number, prompt: string, options: ResumeHistoricalTaskOptions = {}): Promise<ResumeHistoricalTaskResult> {
	const runDirectory = await findRunDirectory(join(cwd, ".pi", "herdr-subagents", "runs"), requestedRunId);
	if (!runDirectory) throw new Error(`Unknown Subagent run '${requestedRunId}'.`);
	const runFile = join(runDirectory, "run.json");
	const initialRun = await readRunRecord(runFile);
	const entries = await readTaskEntries(runDirectory);
	const selected = entries.find(({ task }) => task.order === taskNumber);
	if (!selected) throw new Error(`Unknown historical task ${initialRun.id}#${taskNumber}.`);
	const { directory: taskDirectory } = selected;
	const taskFile = join(taskDirectory, "task.json");
	const taskLock = await acquireDirectoryLock(join(taskDirectory, ".resume.lock"), {
		wait: false,
		signal: options.signal,
		contentionMessage: `Historical task ${initialRun.id}#${taskNumber} already has a resume or response in progress.`,
	});
	try {
		return await resumeLocked(cwd, runDirectory, runFile, taskDirectory, taskFile, prompt, options);
	} finally {
		await taskLock.release();
	}
}

async function resumeLocked(cwd: string, runDirectory: string, runFile: string, taskDirectory: string, taskFile: string, prompt: string, options: ResumeHistoricalTaskOptions): Promise<ResumeHistoricalTaskResult> {
	const herdr = options.herdr ?? new CliHerdrAutomation();
	const task = await readTaskRecord(taskFile);
	const initialRun = await readRunRecord(runFile);
	if (!existsSync(task.sessionFile ?? "")) throw new Error(`Historical task ${initialRun.id}#${task.order} has no saved Pi session.`);
	const attempt = Number(task.attempt ?? 1) + 1;
	const attemptId = createAttemptId();
	const ownerToken = randomUUID();
	const agentName = liveAgentName(task.id, attempt);
	const turnsDirectory = join(taskDirectory, "turns");
	await mkdir(turnsDirectory, { recursive: true, mode: 0o700 });
	const initialTurnFile = join(turnsDirectory, "01.json");
	if (!existsSync(initialTurnFile)) {
		let report: PersistedReport;
		try { report = await readReport(join(taskDirectory, "report.json")); }
		catch (error) { report = { status: "failed", summary: `Previous structured report was unavailable: ${error instanceof Error ? error.message : String(error)}`, documents: [] }; }
		await writeJsonAtomic(initialTurnFile, { attempt: 1, prompt: task.prompt, status: task.status, summary: report.summary, question: report.question, error: report.error, documents: report.documents, sessionFile: task.sessionFile, startedAt: task.startedAt, completedAt: task.completedAt });
	}
	const turnFile = join(turnsDirectory, `${String(attempt).padStart(2, "0")}.json`);
	const followupPrompt = join(taskDirectory, "followup-system-prompt.md");
	await writeTextAtomic(followupPrompt, `${continuationSystemPrompt(task.systemPrompt, "Continue the requested historical work.", "followup")}\n`);
	let allocation: { tabId: string; paneId: string; generation: number } | undefined;
	let failed: { status: "cancelled" | "failed"; report: PersistedReport; error: unknown } | undefined;
	const paneLabel = `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent ?? "worker"}`;
	try {
		allocation = await withRunStateLock(runFile, options.signal, async (run) => {
			if (isActiveStatus(run.status) && (!run.resume || Object.keys(run.resume.active).length === 0)) {
				throw new Error(`Subagent run '${run.id}' is still active. Use action 'respond' for blocked work or wait for it to settle before resuming history.`);
			}
			if (run.resume?.active[task.id]) throw new Error(`Historical task ${run.id}#${task.order} already has an active resume.`);
			const env = childEnvironment(taskDirectory);
			let generation: number;
			let tabId: string;
			let paneId: string;
			let paneIds: string[];
			if (run.resume?.phase === "active") {
				generation = run.resume.generation;
				tabId = run.resume.tabId;
				const anchor = run.resume.paneIds.at(-1);
				if (!anchor) throw new Error(`Resume generation ${generation} has no pane anchor.`);
				paneId = (await herdr.splitPane({ paneId: anchor, cwd, direction: run.resume.paneIds.length % 2 ? "right" : "down", focus: false, env, signal: options.signal })).paneId;
				paneIds = [...run.resume.paneIds, paneId];
			} else {
				generation = Number(run.resume?.generation ?? 0) + 1;
				const created = await herdr.createTab({ workspaceId: process.env.HERDR_WORKSPACE_ID ?? "", cwd, label: `SA · ${run.label}`, env, focus: false, signal: options.signal });
				tabId = created.tabId;
				paneId = created.paneId;
				paneIds = [paneId];
			}
			const member: ResumeMember = { paneId, generation, agentName, attemptId, ownerToken, phase: "allocating", ...ownerRecord(options.owner) };
			run.resume = { generation, phase: "active", tabId, paneIds, active: { ...(run.resume?.phase === "active" ? run.resume.active : {}), [task.id]: member } };
			applyRunStatus(run, "running");
			Object.assign(run, { tabId, paneIds: [...new Set([...(run.paneIds ?? []), paneId])] });
			return { tabId, paneId, generation };
		});
		await herdr.renamePane(allocation.paneId, paneLabel, options.signal);
		applyTaskStatus(task, "running");
		Object.assign(task, { attempt, currentAttemptId: attemptId, currentTurnFile: turnFile, tabId: allocation.tabId, paneId: allocation.paneId, paneLabel, agentName });
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status: "running", sessionFile: task.sessionFile, tabId: allocation.tabId, paneId: allocation.paneId, agentName, startedAt: new Date().toISOString() }),
		]);
		await withRunStateLock(runFile, options.signal, (run) => {
			const member = run.resume?.active[task.id];
			if (member?.attemptId === attemptId && member.generation === allocation?.generation && member.phase === "allocating") member.phase = "running";
		});
		const runningEntries = await readTaskEntries(runDirectory);
		options.onUpdate?.({ runId: initialRun.id, label: initialRun.label, status: "running", summary: `${task.name ?? task.agent} is continuing.`, documents: [], tabId: allocation.tabId, paneId: allocation.paneId, sessionFile: task.sessionFile as string, activity: runningEntries.map(({ task }, index) => projectTaskActivity(task, index)) });
		let report: PersistedReport;
		let status: "blocked" | "completed" | "failed";
		try {
			const prompted = await promptLiveAgent({ herdr, task: { ...task, sessionFile: task.sessionFile as string }, paneId: allocation.paneId, prompt, systemPromptFile: followupPrompt, agentName, attemptId, signal: options.signal, stalledWarningMs: options.stalledWarningSeconds ? options.stalledWarningSeconds * 1000 : undefined, onStalled: () => options.onStalled?.(`${task.name ?? task.agent} appears stalled; it is still running.`), onRuntimeUpdate: async (updated) => {
				Object.assign(task, updated);
				const liveEntries = await readTaskEntries(runDirectory);
				options.onUpdate?.({ runId: initialRun.id, label: initialRun.label, status: "running", summary: `${task.name ?? task.agent} runtime: ${updated.runtimeState}.`, documents: [], tabId: allocation?.tabId ?? "", paneId: allocation?.paneId ?? "", sessionFile: task.sessionFile as string, activity: liveEntries.map(({ task }, index) => projectTaskActivity(task, index)) });
			} });
			report = prompted.report;
			status = applyReport(task, report);
		} catch (error) {
			const settled = await settleAttemptFailure(task, join(taskDirectory, "report.json"), { cancelled: isAbortError(error, options.signal), error: error instanceof Error ? error.message : String(error), name: `${task.name ?? task.agent} follow-up`, replaceReport: true });
			failed = { ...settled, error };
			throw error;
		}
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status, summary: report.summary, documents: report.documents, sessionFile: task.sessionFile, tabId: allocation.tabId, paneId: allocation.paneId, agentName, completedAt: new Date().toISOString(), ...(report.question ? { question: report.question } : {}), ...(report.error ? { error: report.error } : {}) }),
		]);
		const cleanup = await settleMember(runDirectory, runFile, task.id, attemptId, allocation.generation, status, report.question, options);
		if (cleanup) await closeClaimedTab(herdr, runFile, cleanup, options);
		const finalEntries = await readTaskEntries(runDirectory);
		return { runId: initialRun.id, label: initialRun.label, status, summary: report.summary, documents: report.documents, tabId: allocation.tabId, paneId: allocation.paneId, sessionFile: task.sessionFile as string, activity: finalEntries.map(({ task }, index) => projectTaskActivity(task, index)) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!failed) {
			const settled = await settleAttemptFailure(task, join(taskDirectory, "report.json"), { cancelled: isAbortError(error, options.signal), error: message, name: `${task.name ?? task.agent} follow-up`, replaceReport: true });
			failed = { ...settled, error };
		}
		task.attempt = attempt;
		await Promise.all([
			writeJsonAtomic(taskFile, task),
			writeJsonAtomic(turnFile, { attempt, prompt, status: failed.status, summary: failed.report.summary, documents: failed.report.documents, error: message, sessionFile: task.sessionFile, ...(allocation ? { tabId: allocation.tabId, paneId: allocation.paneId } : {}), completedAt: new Date().toISOString() }),
		]);
		let cleanup: { tabId: string; generation: number } | undefined;
		if (allocation) cleanup = await settleMember(runDirectory, runFile, task.id, attemptId, allocation.generation, failed.status, undefined, options);
		else await withRunStateLock(runFile, options.signal, async (run) => applyRunStatus(run, await aggregateRun(runDirectory), { error: message }));
		if (cleanup) await closeClaimedTab(herdr, runFile, cleanup, options);
		const finalEntries = await readTaskEntries(runDirectory);
		options.onUpdate?.({ runId: initialRun.id, label: initialRun.label, status: failed.status, summary: failed.report.summary, documents: failed.report.documents, tabId: allocation?.tabId ?? "", paneId: allocation?.paneId ?? "", sessionFile: task.sessionFile as string, activity: finalEntries.map(({ task }, index) => projectTaskActivity(task, index)) });
		throw error;
	}
}

async function settleMember(runDirectory: string, runFile: string, taskId: string, attemptId: string, generation: number, status: "blocked" | "completed" | "failed" | "cancelled", question: string | undefined, options: ResumeHistoricalTaskOptions): Promise<{ tabId: string; generation: number } | undefined> {
	return withRunStateLock(runFile, options.signal, async (run) => {
		const member = run.resume?.active[taskId];
		if (!member || member.attemptId !== attemptId || member.generation !== generation) return undefined;
		if (status === "blocked") member.phase = "blocked";
		else if (run.resume) delete run.resume.active[taskId];
		const aggregate = await aggregateRun(runDirectory, run.resume?.active);
		applyRunStatus(run, aggregate, { question });
		if (status === "blocked") return undefined;
		return claimResumeCleanup(run);
	});
}

async function closeClaimedTab(herdr: HerdrAutomation, runFile: string, claim: { tabId: string; generation: number }, options: ResumeHistoricalTaskOptions): Promise<void> {
	const snapshot = await readRunRecord(runFile);
	await cleanupRunTab({
		herdr,
		tabId: claim.tabId,
		runFile,
		runRecord: snapshot,
		signal: options.signal,
		onError: options.onCleanupError,
		onClosed: (latest) => {
			if (latest.resume?.generation === claim.generation && latest.resume.phase === "closing") delete latest.resume;
		},
	});
}
