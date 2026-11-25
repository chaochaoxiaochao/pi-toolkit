// Regression for the former silent-child hang: idle is not exit, and a failed
// prompt acknowledgement does not prove the child failed. Advance with explicit
// observation gates, never a grace-period sleep.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptLiveAgent } from "../src/live-agent.ts";

async function scenario(finish, { acknowledgement = "error", observationFailure = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "herdr-live-contract-"));
	writeFileSync(join(directory, "task.json"), "{}");
	const controller = new AbortController();
	const observed = Promise.withResolvers();
	const changed = Promise.withResolvers();
	let alive = true;
	let settled = false;
	const herdr = {
		async startAgent() {},
		async promptAgent() {
			// The child accepted the prompt: its before_agent_start wrote the attempt state.
			const task = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
			writeFileSync(join(directory, "attempts", `${task.currentAttemptId}.json`), JSON.stringify({ attemptId: task.currentAttemptId, state: "working", at: new Date().toISOString() }));
			if (acknowledgement === "error") throw new Error("transport acknowledgement lost");
			return { status: acknowledgement };
		},
		async isTaskRunning() {
			observed.resolve();
			if (observationFailure) { observationFailure = false; throw new Error("temporary process-info failure"); }
			return alive;
		},
		async waitForAgentChange(_name, signal) {
			if (signal.aborted) throw signal.reason;
			return new Promise((resolve, reject) => {
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				changed.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
			});
		},
	};
	const result = promptLiveAgent({ herdr, task: { id: "test", sessionFile: join(directory, "session.jsonl") }, paneId: "pane", prompt: "work", systemPromptFile: join(directory, "system.md"), signal: controller.signal });
	// Attach both handlers immediately so an expected failure cannot become unhandled.
	const outcome = result.then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
	try {
		assert.equal(await Promise.race([observed.promise.then(() => true), outcome.then(() => false)]), true, "a living child must reach process observation before completing");
		assert.equal(settled, false, "a living silent child must not fail just because prompt delivery returned");
		finish({ directory, controller, exit: () => { alive = false; }, wake: () => changed.resolve() });
		return await outcome;
	} finally {
		controller.abort(new Error("test cleanup"));
		changed.resolve();
		await outcome;
		rmSync(directory, { recursive: true, force: true });
	}
}

const reported = await scenario(({ directory, wake }) => {
	const task = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
	mkdirSync(join(directory, "reports"), { recursive: true });
	writeFileSync(join(directory, "reports", `${task.currentAttemptId}.json`), JSON.stringify({ attemptId: task.currentAttemptId, status: "completed", summary: "report arrived", documents: [] }));
	wake();
});
assert.equal(reported.value.report.summary, "report arrived");
const exited = await scenario(({ exit, wake }) => { exit(); wake(); });
assert.match(exited.error.message, /exited without submitting/);
const aborted = await scenario(({ controller }) => controller.abort(new Error("cancelled explicitly")));
assert.equal(aborted.error.message, "cancelled explicitly");
console.log("PASS live-child report, exited-child missing report, and explicit cancellation without timed delays");

for (const acknowledgement of ["idle", "done"]) {
	const late = await scenario(({ directory, wake }) => {
		const task = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
		writeFileSync(join(directory, "reports", `${task.currentAttemptId}.json`), JSON.stringify({ attemptId: task.currentAttemptId, status: "completed", summary: "late report", documents: [] }));
		wake();
	}, { acknowledgement, observationFailure: true });
	assert.equal(late.value?.report.summary, "late report", `${acknowledgement} and a transient observation error must not settle the task`);
}

const directory = mkdtempSync(join(tmpdir(), "herdr-report-acknowledgement-"));
const controller = new AbortController();
let promptAborted = false;
writeFileSync(join(directory, "task.json"), "{}");
try {
	const result = await promptLiveAgent({
		task: { id: "report-first", sessionFile: join(directory, "session.jsonl") }, paneId: "pane", prompt: "work", systemPromptFile: join(directory, "system.md"), signal: controller.signal,
		herdr: {
			async startAgent() {},
			async promptAgent({ signal }) {
				const task = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
				writeFileSync(join(directory, "reports", `${task.currentAttemptId}.json`), JSON.stringify({ attemptId: task.currentAttemptId, status: "completed", summary: "report first", documents: [] }));
				await new Promise((resolve) => signal.addEventListener("abort", () => { promptAborted = true; resolve(); }, { once: true }));
			},
			async isTaskRunning() { return true; },
		},
	});
	assert.equal(result.report.summary, "report first");
	assert.equal(promptAborted, true, "a final report must stop the outstanding prompt acknowledgement");
} finally {
	controller.abort();
	rmSync(directory, { recursive: true, force: true });
}
console.log("PASS idle/done acknowledgements, observation errors and report-first prompt cancellation");

{
	const directory = mkdtempSync(join(tmpdir(), "herdr-live-runtime-"));
	writeFileSync(join(directory, "task.json"), "{}");
	let pendingWakes = 0;
	const waiters = [];
	const wake = () => {
		const waiter = waiters.shift();
		if (waiter) waiter();
		else pendingWakes += 1;
	};
	const started = Promise.withResolvers();
	const waiting = Promise.withResolvers();
	const workingAgain = Promise.withResolvers();
	const runtime = [];
	try {
		const result = promptLiveAgent({
			task: { id: "runtime", sessionFile: join(directory, "session.jsonl") }, paneId: "pane", prompt: "work", systemPromptFile: join(directory, "system.md"),
			onRuntimeUpdate(update) {
				runtime.push(update);
				if (update.state === "waiting_interaction") waiting.resolve();
				if (runtime.some((entry) => entry.state === "waiting_interaction") && update.state === "working") workingAgain.resolve();
			},
			herdr: {
				async startAgent() {},
				async promptAgent() {
					const task = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
					mkdirSync(join(directory, "attempts"), { recursive: true });
					writeFileSync(join(directory, "attempts", `${task.currentAttemptId}.json`), JSON.stringify({ attemptId: task.currentAttemptId, state: "working", at: new Date().toISOString() }));
					started.resolve(task.currentAttemptId);
				},
				async isTaskRunning() { return true; },
				async waitForAgentChange() {
					if (pendingWakes > 0) { pendingWakes -= 1; return; }
					return new Promise((resolve) => waiters.push(resolve));
				},
			},
		});
		const attemptId = await started.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		writeFileSync(join(directory, "attempts", `${attemptId}.json`), JSON.stringify({
			attemptId, state: "waiting_interaction", at: new Date().toISOString(), diagnostic: "Provider quota requires attention.",
		}));
		wake();
		await waiting.promise;
		writeFileSync(join(directory, "attempts", `${attemptId}.json`), JSON.stringify({ attemptId, state: "working", at: new Date().toISOString() }));
		wake();
		await workingAgain.promise;
		mkdirSync(join(directory, "reports"), { recursive: true });
		writeFileSync(join(directory, "reports", `${attemptId}.json`), JSON.stringify({ attemptId, status: "completed", summary: "recovered", documents: [] }));
		wake();
		assert.equal((await result).report.summary, "recovered");
		assert.equal(runtime.find((entry) => entry.state === "waiting_interaction")?.diagnostic, "Provider quota requires attention.");
	} finally {
		wake();
		rmSync(directory, { recursive: true, force: true });
	}
}
console.log("PASS provider-error runtime waits for interaction and returns to working before reporting");

// The former stuck-forever case: delivery failed and the child never started the
// attempt (prompt left unsubmitted in the input box). It must fail with the cause.
const unaccepted = mkdtempSync(join(tmpdir(), "herdr-prompt-unaccepted-"));
writeFileSync(join(unaccepted, "task.json"), "{}");
try {
	let waits = 0;
	const error = await promptLiveAgent({
		task: { id: "unaccepted", sessionFile: join(unaccepted, "session.jsonl") }, paneId: "pane", prompt: "work", systemPromptFile: join(unaccepted, "system.md"),
		herdr: {
			async startAgent() {},
			async promptAgent() { throw new Error("Herdr command failed: agent_prompt_stalled"); },
			async isTaskRunning() { return true; },
			// Never wakes on its own: only the delivery failure may end the wait.
			async waitForAgentChange() { waits += 1; return new Promise(() => {}); },
		},
	}).then(() => assert.fail("an unaccepted prompt must not complete"), (error) => error);
	assert.match(error.message, /did not accept the prompt: .*agent_prompt_stalled/);
	assert.ok(waits <= 1, "the delivery failure must wake the wait loop");
} finally {
	rmSync(unaccepted, { recursive: true, force: true });
}
console.log("PASS unaccepted prompt delivery fails with the Herdr cause instead of waiting forever");
