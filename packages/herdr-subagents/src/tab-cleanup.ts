import type { HerdrAutomation } from "./herdr.ts";
import { readRunRecord, type RunRecord } from "./records.ts";
import { writeJsonAtomic } from "./state.ts";

export async function cleanupRunTab(options: {
	herdr: HerdrAutomation;
	tabId: string;
	runFile: string;
	runRecord: RunRecord;
	signal?: AbortSignal;
	onError?: (message: string) => void;
	onClosed?: (runRecord: RunRecord) => void | Promise<void>;
	failureStatus?: "failed";
	errorPrefix?: string;
}): Promise<{ deferred: boolean }> {
	const mergeLatest = async (update: (run: RunRecord) => void | Promise<void>, requirePending = false, clearPending = true) => {
		const latest = await readRunRecord(options.runFile);
		if (requirePending && !latest.cleanupPendingTabIds?.includes(options.tabId)) return;
		if (clearPending) {
			latest.cleanupPendingTabIds = latest.cleanupPendingTabIds?.filter((tabId) => tabId !== options.tabId);
			if (!latest.cleanupPendingTabIds?.length) delete latest.cleanupPendingTabIds;
		}
		await update(latest);
		await writeJsonAtomic(options.runFile, latest);
		const mutableRecord = options.runRecord as unknown as Record<string, unknown>;
		for (const key of Object.keys(mutableRecord)) if (!(key in latest)) delete mutableRecord[key];
		Object.assign(options.runRecord, latest);
	};
	const reportFailure = async (error: unknown, requirePending = false) => {
		const detail = error instanceof Error ? error.message : String(error);
		try {
			await mergeLatest((latest) => Object.assign(latest, { cleanupPendingTabIds: [...new Set([...(latest.cleanupPendingTabIds ?? []), options.tabId])], cleanupError: detail, ...(options.failureStatus ? { status: options.failureStatus } : {}) }), requirePending, false);
		} catch (persistError) {
			options.onError?.(`${options.errorPrefix ?? "Herdr tab cleanup failed"}: ${detail}; could not persist cleanup state: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
			return;
		}
		options.onError?.(`${options.errorPrefix ?? "Herdr tab cleanup failed"}: ${detail}`);
	};
	const finishClosed = async (requirePending = false) => mergeLatest(async (latest) => options.onClosed?.(latest), requirePending);
	try {
		if (options.signal?.aborted) {
			await options.herdr.closeTab(options.tabId);
			await finishClosed();
			return { deferred: false };
		}
		if (await options.herdr.isTabFocused(options.tabId, options.signal)) {
			const latest = await readRunRecord(options.runFile);
			latest.cleanupPendingTabIds = [...new Set([...(latest.cleanupPendingTabIds ?? []), options.tabId])];
			await writeJsonAtomic(options.runFile, latest);
			Object.assign(options.runRecord, latest);
			void options.herdr.waitForTabUnfocused(options.tabId, options.signal)
				.then(() => options.herdr.closeTab(options.tabId, options.signal))
				.then(() => finishClosed(true))
				.catch(async (error) => {
					if (!options.signal?.aborted) { await reportFailure(error, true); return; }
					try {
						await options.herdr.closeTab(options.tabId);
						await finishClosed(true);
					} catch (closeError) { await reportFailure(closeError, true); }
				});
			return { deferred: true };
		}
		await options.herdr.closeTab(options.tabId, options.signal);
		await finishClosed();
	}
	catch (error) { await reportFailure(error); throw error; }
	return { deferred: false };
}
