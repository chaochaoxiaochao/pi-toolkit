import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRunTab } from "../src/tab-cleanup.ts";
import { acquireDirectoryLock } from "../src/run-state.ts";
import { writeJsonAtomic } from "../src/state.ts";
import { waitFor } from "./wait-for.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-herdr-cleanup-timing-"));
try {
	await assert.rejects(waitFor(() => false, "controlled missing completion", 20), /Timed out.*controlled missing completion/);
	for (const failClose of [false, true]) {
		const runFile = join(root, "run.json");
		const run = { id: "cleanup-timing", label: "cleanup-timing", status: "completed" };
		await writeJsonAtomic(runFile, run);
		let leaveFocus;
		const focus = new Promise((resolve) => { leaveFocus = resolve; });
		let closeAttempted = false;
		const herdr = {
			async isTabFocused() { return true; },
			async waitForTabUnfocused() { await focus; },
			async closeTab() {
				closeAttempted = true;
				if (failClose) throw new Error("controlled close failure");
			},
		};
		const cleanup = await cleanupRunTab({ herdr, tabId: "test-tab", runFile, runRecord: run });
		assert.equal(cleanup.deferred, true);
		const lock = await acquireDirectoryLock(join(root, ".state.lock"), { wait: true });
		try {
			leaveFocus();
			await waitFor(() => closeAttempted, "controlled close attempt");
			await new Promise((resolve) => setTimeout(resolve, 10));
			const premature = JSON.parse(readFileSync(runFile, "utf8"));
			assert.deepEqual(premature.cleanupPendingTabIds, ["test-tab"]);
			assert.equal(premature.cleanupError, undefined);
			console.log(`REPRO ${failClose ? "error persistence" : "successful cleanup"}: at the old 10 ms assertion point, the legitimate run-state lock keeps cleanup pending`);
		} finally {
			await lock.release();
		}
		const settled = await waitFor(() => {
			const record = JSON.parse(readFileSync(runFile, "utf8"));
			return (failClose ? record.cleanupError : !record.cleanupPendingTabIds) ? record : false;
		}, "cleanup state commit");
		assert.equal(settled.status, "completed");
		if (failClose) {
			assert.equal(settled.cleanupError, "controlled close failure");
			assert.deepEqual(settled.cleanupPendingTabIds, ["test-tab"]);
		} else {
			assert.equal(settled.cleanupPendingTabIds, undefined);
			assert.equal(settled.cleanupError, undefined);
		}
		// Wait for the detached chain's lock release before reusing or deleting its record.
		const joined = await acquireDirectoryLock(join(root, ".state.lock"), { wait: true });
		await joined.release();
		console.log(`PASS ${failClose ? "error persistence" : "successful cleanup"} settles after the lock releases`);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
