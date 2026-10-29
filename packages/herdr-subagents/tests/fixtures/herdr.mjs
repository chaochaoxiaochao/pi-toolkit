import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
export const readTask = (directory) => readJson(join(directory, "task.json"));

/** Resolves only when the test advances work; cancellation also releases its listener. */
export async function waitGate(gate, signal) {
	if (signal?.aborted) throw signal.reason;
	let abort;
	try {
		await Promise.race([gate.promise, new Promise((_, reject) => {
			abort = () => reject(signal.reason);
			signal?.addEventListener("abort", abort, { once: true });
		})]);
	} finally { if (abort) signal?.removeEventListener("abort", abort); }
}

/** Real files and public batch execution, with deterministic Herdr process/report events. */
export function batchFixture(onPrompt) {
	const root = mkdtempSync(join(tmpdir(), "herdr-regression-"));
	const calls = [];
	const agents = new Map();
	const panes = new Map();
	let sequence = 0;
	const publish = (directory, report = {}) => {
		const task = readTask(directory);
		writeJson(join(directory, "reports", `${task.currentAttemptId}.json`), {
			attemptId: task.currentAttemptId, status: "completed", summary: `${task.name} completed`, documents: [], ...report,
		});
		const pane = panes.get(task.paneId);
		if (pane) { pane.alive = false; pane.changed.resolve(); }
	};
	const methods = {
		async createTab(request) { return { tabId: "tab-1", paneId: `pane-${++sequence}` }; },
		async splitPane() { return { paneId: `pane-${++sequence}` }; },
		async startAgent(request) {
			const directory = dirname(request.args[request.args.indexOf("--session") + 1]);
			const state = { directory, alive: true, changed: Promise.withResolvers(), request };
			agents.set(request.name, state);
			panes.set(request.paneId, state);
		},
		async promptAgent(request) {
			const state = agents.get(request.target);
			if (onPrompt) return onPrompt({ ...state, request, publish });
			publish(state.directory);
			return { status: "idle" };
		},
		async isTaskRunning(paneId) { return panes.get(paneId)?.alive === true; },
		async waitForAgentChange(target, signal) { await waitGate(agents.get(target).changed, signal); },
		async renamePane() {}, async renameTab() {}, async focusPane() {},
		async isTabFocused() { return false; }, async waitForTabUnfocused() {},
		async paneExists() { return true; }, async closeTab() {},
	};
	const herdr = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => {
		calls.push([name, ...args]);
		return fn(...args);
	}]));
	return { root, calls, herdr, agents, panes, publish, close: () => rmSync(root, { recursive: true, force: true }) };
}

export function batchTask(name, overrides = {}) {
	return { name, prompt: name, agent: "explorer", access: "read", tools: ["read"], skills: [], extensions: [], systemPrompt: "Read only.", ...overrides };
}

/** A durable ordinary run, also usable as a legacy read-only history input. */
export function durableRun(root, id, status = "completed", overrides = {}) {
	const directory = join(root, ".pi", "herdr-subagents", "runs", id);
	const taskDirectory = join(directory, "tasks", "01-task");
	const runFile = join(directory, "run.json");
	const taskFile = join(taskDirectory, "task.json");
	const run = { id, label: id, status, startedAt: "2026-10-28T00:00:00Z", taskIds: [`${id}-task`], tabId: `${id}-tab`, ...overrides };
	const task = { id: `${id}-task`, runId: id, order: 1, name: `${id}-task`, agent: "explorer", status, sessionFile: join(taskDirectory, "session.jsonl") };
	writeJson(runFile, run);
	writeJson(taskFile, task);
	if (["completed", "failed", "blocked", "cancelled"].includes(status)) writeJson(join(taskDirectory, "report.json"), {
		status: status === "cancelled" ? "failed" : status, summary: `${id} summary`, documents: [{ path: join(taskDirectory, "result.md"), description: "full result" }], ...(status === "blocked" ? { question: "legacy question" } : {}),
	});
	return { directory, taskDirectory, runFile, taskFile, run, task };
}
