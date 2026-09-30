import type { HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic } from "./state.ts";

export async function cleanupRunTab(options: {
	herdr: HerdrAutomation;
	tabId: string;
	runFile: string;
	runRecord: object;
	signal?: AbortSignal;
	onError?: (message: string) => void;
}): Promise<{ deferred: boolean }> {
	const reportFailure = async (error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		(options.runRecord as { cleanupError?: string }).cleanupError = detail;
		await writeJsonAtomic(options.runFile, options.runRecord);
		options.onError?.(`Herdr tab cleanup failed: ${detail}`);
	};
	if (await options.herdr.isTabFocused(options.tabId, options.signal)) {
		void options.herdr.waitForTabUnfocused(options.tabId, options.signal)
			.then(() => options.herdr.closeTab(options.tabId, options.signal))
			.catch(reportFailure);
		return { deferred: true };
	}
	try { await options.herdr.closeTab(options.tabId, options.signal); }
	catch (error) { await reportFailure(error); throw error; }
	return { deferred: false };
}
