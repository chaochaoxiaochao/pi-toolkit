import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import { isProcessAlive, type OwnerIdentity } from "./ownership.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, isActiveStatus, normalizeNeedsInputReport, persistFailureReport, readReport, readRunRecord, readTaskRecord, settleAttemptFailure, type RunRecord } from "./records.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { attemptReportPath } from "./attempts.ts";
import { writeJsonAtomic } from "./state.ts";
import { withRunStateLock } from "./run-state.ts";
import { aggregateTasksWithResume, claimResumeCleanup, memberOwnedBy, memberOwnerIsStale, readTaskEntries, type ResumeCleanupClaim } from "./resume-state.ts";

export interface CancellationResult { cancelledRuns: number; cleanupErrors: string[]; }
export interface ReconciliationResult { liveTasks: number; settledTasks: number; interruptedTasks: number; cancelledTasks: number; cleanupErrors: string[]; }

async function closeRunTab(run: RunRecord, runFile: string, herdr: HerdrAutomation, cleanupErrors: string[], claim?: ResumeCleanupClaim): Promise<void> {
	const tabId = claim?.tabId ?? run.tabId;
	if (!tabId) return;
	const forceClose = new AbortController();
	forceClose.abort(new Error("Owning parent Pi session is no longer active."));
	const errorsBeforeCleanup = cleanupErrors.length;
	try {
		await cleanupRunTab({
			herdr, tabId, runFile, runRecord: run, signal: forceClose.signal,
			onError: (message) => cleanupErrors.push(message), errorPrefix: `Could not close Subagent tab ${tabId}`,
			onClosed: claim ? (latest) => { if (latest.resume?.generation === claim.generation && latest.resume.phase === "closing") delete latest.resume; } : undefined,
		});
	} catch (error) {
		if (cleanupErrors.length === errorsBeforeCleanup) cleanupErrors.push(`Could not close Subagent tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface CancelActiveRunsOptions { reason?: string; owner?: OwnerIdentity; runId?: string; }

export async function cancelActiveSubagentRuns(cwd: string, herdr: HerdrAutomation, options: CancelActiveRunsOptions = {}): Promise<CancellationResult> {
	const reason = options.reason ?? "Parent Pi session closed.";
	const result: CancellationResult = { cancelledRuns: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let snapshot: RunRecord;
		try { snapshot = await readRunRecord(runFile); } catch (error) { result.cleanupErrors.push(`Could not inspect Subagent run ${runFile}: ${error instanceof Error ? error.message : String(error)}`); continue; }
		if (options.runId && snapshot.id !== options.runId) continue;
		let affected = false;
		let claim: ResumeCleanupClaim | undefined;
		let latest = snapshot;
		try {
			latest = await withRunStateLock(runFile, undefined, async (run) => {
				const entries = await readTaskEntries(runDirectory);
				if (run.resume?.phase === "active") {
					for (const [taskId, member] of Object.entries(run.resume.active)) {
						if (!memberOwnedBy(member, options.owner)) continue;
						const entry = entries.find(({ task }) => task.id === taskId);
						if (entry && (member.phase === "allocating" || entry.task.currentAttemptId === member.attemptId)) {
							entry.task.currentAttemptId = member.attemptId;
							if (isActiveStatus(entry.task.status) || member.phase === "allocating") {
								applyTaskStatus(entry.task, "cancelled", { error: reason });
								await writeJsonAtomic(join(entry.directory, "task.json"), entry.task);
							}
						}
						delete run.resume.active[taskId];
						affected = true;
					}
					applyRunStatus(run, aggregateTasksWithResume(entries.map(({ task }) => task), run.resume.active), { error: reason });
					claim = claimResumeCleanup(run);
					return run;
				}
				const ownerMatches = !options.owner?.sessionId || run.ownerSessionId === options.owner.sessionId;
				if (!ownerMatches || !isActiveStatus(run.status)) return run;
				for (const { directory, task } of entries) {
					if (!isActiveStatus(task.status)) continue;
					applyTaskStatus(task, "cancelled", { error: reason });
					await writeJsonAtomic(join(directory, "task.json"), task);
				}
				applyRunStatus(run, "cancelled", { error: reason });
				affected = true;
				return run;
			});
		} catch (error) { result.cleanupErrors.push(`Could not cancel Subagent run ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`); continue; }
		if (!affected) continue;
		if (claim || (!latest.resume && latest.status === "cancelled")) await closeRunTab(latest, runFile, herdr, result.cleanupErrors, claim);
		result.cancelledRuns += 1;
	}
	return result;
}

export async function reconcileSubagentRuns(cwd: string, herdr: HerdrAutomation, owner?: OwnerIdentity): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { liveTasks: 0, settledTasks: 0, interruptedTasks: 0, cancelledTasks: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let snapshot: RunRecord;
		try { snapshot = await readRunRecord(runFile); } catch (error) { result.cleanupErrors.push(`Could not inspect Subagent run ${runFile}: ${error instanceof Error ? error.message : String(error)}`); continue; }
		for (const pendingTabId of [...(snapshot.cleanupPendingTabIds ?? [])]) {
			try { await cleanupRunTab({ herdr, tabId: pendingTabId, runFile, runRecord: snapshot, onError: (message) => result.cleanupErrors.push(message), errorPrefix: `Could not finish deferred cleanup for Herdr tab ${pendingTabId}` }); }
			catch (error) { result.cleanupErrors.push(`Could not finish deferred cleanup for Herdr tab ${pendingTabId}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		const tasksDirectory = join(runDirectory, "tasks");
		if (!existsSync(tasksDirectory)) {
			const message = `Active Subagent run ${snapshot.id} has no tasks directory.`;
			result.cleanupErrors.push(message);
			const failedRun = await withRunStateLock(runFile, undefined, (run) => applyRunStatus(run, "failed", { error: message }));
			result.interruptedTasks += 1;
			await closeRunTab(failedRun, runFile, herdr, result.cleanupErrors);
			continue;
		}
		let claim: ResumeCleanupClaim | undefined;
		let closeRegular = false;
		let latest = snapshot;
		try {
			latest = await withRunStateLock(runFile, undefined, async (run) => {
				const entries = await readTaskEntries(runDirectory);
				// Recover each historical member independently. A live sibling owner is never
				// cancelled merely because another owner invokes reconciliation.
				if (run.resume?.phase === "active") for (const [taskId, member] of Object.entries(run.resume.active)) {
					const entry = entries.find(({ task }) => task.id === taskId);
					if (!entry) { if (memberOwnerIsStale(member, owner)) delete run.resume.active[taskId]; continue; }
					if (member.phase === "allocating" && entry.task.currentAttemptId === member.attemptId && isActiveStatus(entry.task.status)) member.phase = "running";
					const attemptMatches = entry.task.currentAttemptId === member.attemptId;
					if (!memberOwnerIsStale(member, owner)) continue;
					const scopedResumeReport = attemptReportPath(entry.directory, member.attemptId);
					if (existsSync(scopedResumeReport)) {
						try {
							const submitted = await readReport(scopedResumeReport);
							if (submitted.attemptId !== member.attemptId) throw new Error(`Report attempt '${submitted.attemptId ?? "unknown"}' does not match resume member '${member.attemptId}'.`);
							const report = normalizeNeedsInputReport(submitted, 1);
							entry.task.currentAttemptId = member.attemptId;
							const status = applyReport(entry.task, report, report.reportedAt);
							await Promise.all([
								writeJsonAtomic(join(entry.directory, "task.json"), entry.task),
								writeJsonAtomic(join(entry.directory, "report.json"), report),
							]);
							if (status === "blocked") member.phase = "blocked";
							else delete run.resume.active[taskId];
							result.settledTasks += 1;
							continue;
						} catch (error) {
							result.cleanupErrors.push(`Invalid historical resume report ${scopedResumeReport}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (member.phase === "allocating" || attemptMatches) {
						entry.task.currentAttemptId = member.attemptId;
						const reportFile = join(entry.directory, "report.json");
						await settleAttemptFailure(entry.task, reportFile, { cancelled: true, error: "Historical resume owner disappeared before the attempt settled.", name: `${entry.task.name ?? entry.task.agent} follow-up`, replaceReport: true });
						await writeJsonAtomic(join(entry.directory, "task.json"), entry.task);
						result.cancelledTasks += 1; result.interruptedTasks += 1;
					}
					delete run.resume.active[taskId];
				}
				const differentOwner = owner?.sessionId !== undefined && run.ownerSessionId !== owner.sessionId && (run.ownerProcessId === (owner.processId ?? process.pid) || !isProcessAlive(run.ownerProcessId));
				for (const entry of entries) {
					const task = entry.task;
					const member = run.resume?.active[task.id];
					if (member) continue;
					if (!isActiveStatus(task.status)) continue;
					const canonicalReportFile = join(entry.directory, "report.json");
					let scopedReportFile: string | undefined;
					if (task.currentAttemptId) try { scopedReportFile = attemptReportPath(entry.directory, task.currentAttemptId); } catch (error) { result.cleanupErrors.push(`Invalid current attempt for Subagent task ${task.id}: ${error instanceof Error ? error.message : String(error)}`); }
					const reportFile = task.currentAttemptId ? scopedReportFile : canonicalReportFile;
					if (reportFile && existsSync(reportFile) && (task.status === "running" || task.status === "starting")) {
						try {
							const submitted = await readReport(reportFile);
							const report = normalizeNeedsInputReport(submitted, Number(run.effectiveConcurrency) || 1);
							if (task.currentAttemptId && report.attemptId !== task.currentAttemptId) throw new Error(`Report attempt '${report.attemptId ?? "unknown"}' does not match current attempt '${task.currentAttemptId}'.`);
							applyReport(task, report, report.reportedAt);
							if (report !== submitted) await writeJsonAtomic(reportFile, report);
							await writeJsonAtomic(canonicalReportFile, report);
							result.settledTasks += 1;
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							result.cleanupErrors.push(`Invalid Subagent report ${reportFile}: ${detail}`);
							await persistFailureReport(canonicalReportFile, { status: "failed", summary: "Recovered task had an invalid structured report.", documents: [], error: detail }, false);
							applyTaskStatus(task, "failed", { error: `Invalid structured report: ${detail}` }); result.interruptedTasks += 1; result.settledTasks += 1;
						}
						if (differentOwner && task.status === "blocked") {
							const cancelledReport = { status: "failed" as const, summary: "Blocked task was cancelled because its parent Pi session is no longer active.", documents: [], error: "Owning parent Pi session is no longer active.", ...(task.currentAttemptId ? { attemptId: task.currentAttemptId } : {}) };
							await writeJsonAtomic(canonicalReportFile, cancelledReport);
							if (scopedReportFile) await writeJsonAtomic(scopedReportFile, cancelledReport);
							applyTaskStatus(task, "cancelled", { error: cancelledReport.error }); result.cancelledTasks += 1; result.interruptedTasks += 1;
						}
					} else if (differentOwner) {
						applyTaskStatus(task, "cancelled", { error: "Owning parent Pi session is no longer active." }); result.cancelledTasks += 1; result.interruptedTasks += 1;
					} else if (task.status === "running" || task.status === "starting") {
						let live = false;
						try { live = task.paneId ? await herdr.isTaskRunning(task.paneId) : false; } catch (error) { result.cleanupErrors.push(`Could not inspect Subagent pane ${task.paneId}: ${error instanceof Error ? error.message : String(error)}`); live = true; }
						if (live) result.liveTasks += 1;
						else { applyTaskStatus(task, "cancelled", { error: "Child pane disappeared before a structured report was recorded." }); result.cancelledTasks += 1; result.interruptedTasks += 1; }
					}
					await writeJsonAtomic(join(entry.directory, "task.json"), task);
				}
				const refreshed = await readTaskEntries(runDirectory);
				applyRunStatus(run, run.resume ? aggregateTasksWithResume(refreshed.map(({ task }) => task), run.resume.active) : aggregateTaskStatus(refreshed.map(({ task }) => task.status)));
				claim = claimResumeCleanup(run);
				closeRegular = !run.resume && !isActiveStatus(run.status) && (differentOwner || result.interruptedTasks > 0);
				return run;
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			result.cleanupErrors.push(`Could not inspect Subagent task in ${tasksDirectory}: ${detail}`);
			result.interruptedTasks += 1;
			latest = await withRunStateLock(runFile, undefined, (run) => applyRunStatus(run, "failed", { error: detail }));
			closeRegular = true;
		}
		if (claim) await closeRunTab(latest, runFile, herdr, result.cleanupErrors, claim);
		else if (closeRegular) await closeRunTab(latest, runFile, herdr, result.cleanupErrors);
	}
	return result;
}
