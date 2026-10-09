import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";

function harness(execute: (...args: any[]) => Promise<any>) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands: string[] = [];
	let tool: Record<string, any> | undefined;
	let controlTool: Record<string, any> | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widgetCalls = 0;
	let renderedLines: string[] = [];
	const editor = { kind: "editor" };
	const focusedPanes: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const messages: Array<{ message: any; options: any }> = [];
	const messageWaiters: Array<{ predicate: (message: any) => boolean; resolve: () => void }> = [];
	const ui = {
		setWidget(_id: string, widget: unknown) {
			widgetCalls += 1;
			if (typeof widget === "function") (widget as (tui: unknown) => unknown)({ focusedComponent: editor });
		},
		onTerminalInput(callback: typeof terminalInput) { terminalInput = callback; return () => { terminalInput = undefined; }; },
		getEditorText() { return ""; },
		notify(message: string, level?: string) { notifications.push({ message, level }); },
	};
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(definition: Record<string, any>) {
			if (definition.name === "herdr_subagents") tool = definition;
			if (definition.name === "herdr_subagents_control") controlTool = definition;
		},
		registerCommand(name: string) { commands.push(name); },
		sendMessage(message: any, options: any) {
			messages.push({ message, options });
			for (const waiter of messageWaiters.splice(0)) {
				if (waiter.predicate(message)) waiter.resolve();
				else messageWaiters.push(waiter);
			}
		},
	};
	registerHerdrSubagents(pi as never, {
		herdr: { async focusPane(paneId: string) { focusedPanes.push(paneId); } } as never,
		execute: execute as never,
		executeControl: execute as never,
		isEditor: (value) => value === editor,
		createFleetWidget(lines) { renderedLines = lines; return new Container(); },
	});
	return {
		handlers,
		commands,
		get tool() { return tool; },
		get controlTool() { return controlTool; },
		get terminalInput() { return terminalInput; },
		get widgetCalls() { return widgetCalls; },
		get renderedLines() { return renderedLines; },
		focusedPanes,
		notifications,
		messages,
		waitForMessage(predicate: (message: any) => boolean) {
			if (messages.some(({ message }) => predicate(message))) return Promise.resolve();
			return new Promise<void>((resolve) => messageWaiters.push({ predicate, resolve }));
		},
		ui,
	};
}

async function startHarness(instance: ReturnType<typeof harness>, cwd: string) {
	await instance.handlers.get("session_start")?.({}, {
		cwd,
		mode: "tui",
		ui: instance.ui,
		sessionManager: { getSessionId: () => "contract-session" },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

async function verifyForegroundFailureHandoff() {
	const cwd = mkdtempSync(join(tmpdir(), "herdr-early-failure-"));
	try {
		const slow = deferred<void>();
		let slowSignal: AbortSignal | undefined;
		let secondStarted = false;
		let callCount = 0;
		const caller = new AbortController();
		const failedTask = { index: 0, name: "fast failure", status: "failed", summary: "failed quickly", error: "boom", documents: [], paneId: "w1:p1", recordDirectory: "task-1", sessionFile: "task-1/session.jsonl" };
		const slowTask = { index: 1, name: "slow success", status: "completed", summary: "finished slowly", documents: [], paneId: "w1:p2", recordDirectory: "task-2", sessionFile: "task-2/session.jsonl" };
		const instance = harness(async (_params, signal, onUpdate, _ctx, dependencies) => {
			callCount += 1;
			if (callCount > 1) {
				secondStarted = true;
				return { content: [{ type: "text", text: "second done" }], details: { runId: dependencies.runId, label: "second", status: "completed", summary: "done", documents: [], tasks: [], activity: [] } };
			}
			slowSignal = signal;
			onUpdate?.({
				content: [{ type: "text", text: "1/2 tasks settled." }],
				details: { runId: dependencies.runId, label: "handoff", status: "running", summary: "1/2 tasks settled.", documents: [], tasks: [failedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: slowTask.name, status: "running" }], effectiveConcurrency: 2, requestedConcurrency: 2 },
			});
			queueMicrotask(() => caller.abort(new Error("foreground tool call ended")));
			await slow.promise;
			return { content: [{ type: "text", text: "1/2 tasks completed; 1 failed." }], details: { runId: dependencies.runId, label: "handoff", status: "partial", summary: "1/2 tasks completed; 1 failed.", documents: [], tasks: [failedTask, slowTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: slowTask.name, status: "completed" }], effectiveConcurrency: 2, requestedConcurrency: 2 }, isError: true };
		});
		await startHarness(instance, cwd);
		const foreground = instance.tool?.execute("handoff", { concurrency: 2, tasks: [{ name: failedTask.name, prompt: "fail" }, { name: slowTask.name, prompt: "wait" }] }, caller.signal, undefined, { cwd, ui: instance.ui });
		const early = await Promise.race([foreground, new Promise((_, reject) => setTimeout(() => reject(new Error("foreground did not return after the first task failed")), 100))]);
		if (!early.details?.runId || early.details?.earlyReturn !== true || early.details?.background !== true || early.details?.failedTask?.error !== "boom" || !early.content?.[0]?.text.includes("boom")) throw new Error("early foreground result omitted the run ID or failure details");
		if (slowSignal?.aborted) throw new Error("early foreground handoff cancelled the still-running sibling");
		const queuedAfterHandoff = readdirSync(join(cwd, ".pi", "herdr-subagents", "queue")).filter((name) => name.endsWith(".json"));
		if (queuedAfterHandoff.length !== 1) throw new Error("early foreground handoff was not persisted as background work");
		const second = instance.tool?.execute("second", { background: true, tasks: [{ name: "second", prompt: "later" }] }, undefined, undefined, { cwd, ui: instance.ui });
		await second;
		await waitUntil(() => secondStarted, "dispatcher did not start the next batch after the failed foreground batch detached");
		if (slowSignal?.aborted) throw new Error("starting the next batch cancelled the detached slow sibling");
		const handoffNotified = instance.waitForMessage((message) => message.details?.runId === early.details.runId);
		slow.resolve();
		await handoffNotified;
		if (slowSignal?.aborted) throw new Error("detached slow sibling was cancelled before it finished");
		const handoffMessages = instance.messages.filter(({ message }) => message.details?.runId === early.details.runId);
		if (handoffMessages.length !== 1 || handoffMessages[0].options?.deliverAs !== "followUp") throw new Error("handed-off run did not send exactly one final follow-up");
		await waitUntil(() => !readdirSync(join(cwd, ".pi", "herdr-subagents", "queue")).some((name) => name.startsWith(early.details.runId)), "settled handed-off run left its durable queue record behind");

		const blockedRoot = join(cwd, "blocked-handoff");
		mkdirSync(blockedRoot, { recursive: true });
		const becomeBlocked = deferred<void>();
		const finishSuccessor = deferred<void>();
		let blockedCalls = 0;
		let successorStarted = false;
		let thirdStarted = false;
		const blockedTask = { index: 1, name: "needs input", status: "blocked", summary: "waiting for an answer", question: "Continue?", documents: [], paneId: "w1:p2", recordDirectory: "task-2", sessionFile: "task-2/session.jsonl" };
		const blockedHandoff = harness(async (_params, _signal, onUpdate, _ctx, dependencies) => {
			blockedCalls += 1;
			if (blockedCalls === 2) {
				successorStarted = true;
				await finishSuccessor.promise;
				return { content: [{ type: "text", text: "successor done" }], details: { runId: dependencies.runId, label: "successor", status: "completed", summary: "done", documents: [], tasks: [], activity: [] } };
			}
			if (blockedCalls === 3) {
				thirdStarted = true;
				return { content: [{ type: "text", text: "third done" }], details: { runId: dependencies.runId, label: "third", status: "completed", summary: "done", documents: [], tasks: [], activity: [] } };
			}
			onUpdate?.({
				content: [{ type: "text", text: "1/2 tasks settled." }],
				details: { runId: dependencies.runId, label: "blocks later", status: "running", summary: "1/2 tasks settled.", documents: [], tasks: [failedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: blockedTask.name, status: "running" }], effectiveConcurrency: 2, requestedConcurrency: 2 },
			});
			await becomeBlocked.promise;
			return { content: [{ type: "text", text: "run blocked" }], details: { runId: dependencies.runId, label: "blocks later", status: "blocked", summary: "waiting for input", documents: [], tasks: [failedTask, blockedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: blockedTask.name, status: "blocked" }], effectiveConcurrency: 2, requestedConcurrency: 2 } };
		});
		await startHarness(blockedHandoff, blockedRoot);
		const blockedEarly = await blockedHandoff.tool?.execute("blocks-later", { concurrency: 2, tasks: [{ name: failedTask.name, prompt: "fail" }, { name: blockedTask.name, prompt: "block" }] }, undefined, undefined, { cwd: blockedRoot, ui: blockedHandoff.ui });
		await blockedHandoff.tool?.execute("successor", { background: true, tasks: [{ name: "successor", prompt: "wait" }] }, undefined, undefined, { cwd: blockedRoot, ui: blockedHandoff.ui });
		await waitUntil(() => successorStarted, "successor did not start while detached run was still active");
		const blockedNotified = blockedHandoff.waitForMessage((message) => message.details?.runId === blockedEarly.details.runId);
		becomeBlocked.resolve();
		await blockedNotified;
		await blockedHandoff.tool?.execute("third", { background: true, tasks: [{ name: "third", prompt: "later" }] }, undefined, undefined, { cwd: blockedRoot, ui: blockedHandoff.ui });
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (thirdStarted) throw new Error("detached blocked settlement cleared the newer active dispatcher slot");
		if (blockedHandoff.messages.filter(({ message }) => message.details?.runId === blockedEarly.details.runId).length !== 1) throw new Error("detached run that later blocked did not notify exactly once");
		finishSuccessor.resolve();
		await waitUntil(() => thirdStarted, "queued run did not start after the newer active run settled");

		const cancelRoot = join(cwd, "cancel-handoff");
		mkdirSync(cancelRoot, { recursive: true });
		let detachedSignal: AbortSignal | undefined;
		const cancelledHandoff = harness(async (params, signal, onUpdate, _ctx, dependencies) => {
			if (params.action === "cancel") {
				const result = await dependencies.cancelRun(params.runId);
				return { content: [{ type: "text", text: "cancelled" }], details: { action: "cancel", runId: params.runId, ...result } };
			}
			detachedSignal = signal;
			onUpdate?.({
				content: [{ type: "text", text: "1/2 tasks settled." }],
				details: { runId: dependencies.runId, label: "cancel detached", status: "running", summary: "1/2 tasks settled.", documents: [], tasks: [failedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: slowTask.name, status: "running" }], effectiveConcurrency: 2, requestedConcurrency: 2 },
			});
			await new Promise<void>((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		await startHarness(cancelledHandoff, cancelRoot);
		const cancelEarly = await cancelledHandoff.tool?.execute("cancel-detached", { concurrency: 2, tasks: [{ name: failedTask.name, prompt: "fail" }, { name: slowTask.name, prompt: "wait" }] }, undefined, undefined, { cwd: cancelRoot, ui: cancelledHandoff.ui });
		const cancelledNotice = cancelledHandoff.waitForMessage((message) => message.details?.runId === cancelEarly.details.runId);
		const cancelResult = await cancelledHandoff.controlTool?.execute("cancel", { action: "cancel", runId: cancelEarly.details.runId }, undefined, undefined, { cwd: cancelRoot, ui: cancelledHandoff.ui });
		await cancelledNotice;
		if (!detachedSignal?.aborted || cancelResult?.details?.cancelled !== true) throw new Error("cancel did not abort the detached handed-off run");
		if (cancelledHandoff.messages.filter(({ message }) => message.details?.runId === cancelEarly.details.runId).length !== 1) throw new Error("cancelled detached run did not notify exactly once");

		const shutdownRoot = join(cwd, "shutdown-handoff");
		mkdirSync(shutdownRoot, { recursive: true });
		let shutdownSignal: AbortSignal | undefined;
		const shutdownHandoff = harness(async (_params, signal, onUpdate, _ctx, dependencies) => {
			shutdownSignal = signal;
			onUpdate?.({
				content: [{ type: "text", text: "1/2 tasks settled." }],
				details: { runId: dependencies.runId, label: "shutdown", status: "running", summary: "1/2 tasks settled.", documents: [], tasks: [failedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: slowTask.name, status: "running" }], effectiveConcurrency: 2, requestedConcurrency: 2 },
			});
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { content: [{ type: "text", text: "cancelled" }], details: { runId: dependencies.runId, label: "shutdown", status: "cancelled", summary: "cancelled", documents: [], tasks: [failedTask], activity: [{ index: 0, name: failedTask.name, status: "failed" }, { index: 1, name: slowTask.name, status: "cancelled" }], effectiveConcurrency: 2, requestedConcurrency: 2 }, isError: true };
		});
		await startHarness(shutdownHandoff, shutdownRoot);
		const shutdownEarly = await shutdownHandoff.tool?.execute("shutdown", { concurrency: 2, tasks: [{ name: failedTask.name, prompt: "fail" }, { name: slowTask.name, prompt: "wait" }] }, undefined, undefined, { cwd: shutdownRoot, ui: shutdownHandoff.ui });
		await Promise.race([
			shutdownHandoff.handlers.get("session_shutdown")?.({}, { cwd: shutdownRoot, ui: shutdownHandoff.ui }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("session shutdown leaked a handed-off run")), 100)),
		]);
		if (!shutdownSignal?.aborted) throw new Error("session shutdown did not abort the active handed-off sibling");
		if (shutdownHandoff.messages.some(({ message }) => message.details?.runId === shutdownEarly.details.runId)) throw new Error("handed-off run notified after its parent session shut down");
		const shutdownQueue = join(shutdownRoot, ".pi", "herdr-subagents", "queue");
		if (existsSync(shutdownQueue) && readdirSync(shutdownQueue).some((name) => name.endsWith(".json"))) throw new Error("session shutdown left a handed-off queue record behind");

		const successGate = deferred<void>();
		const successStarted = deferred<void>();
		const allSuccess = harness(async (_params, _signal, _onUpdate, _ctx, dependencies) => {
			successStarted.resolve();
			await successGate.promise;
			return { content: [{ type: "text", text: "all done" }], details: { runId: dependencies.runId, label: "success", status: "completed", summary: "2/2 tasks completed.", documents: [], tasks: [], activity: [], effectiveConcurrency: 2, requestedConcurrency: 2 } };
		});
		await startHarness(allSuccess, cwd);
		let successSettled = false;
		const successPromise = allSuccess.tool?.execute("success", { concurrency: 2, tasks: [{ name: "one", prompt: "one" }, { name: "two", prompt: "two" }] }, undefined, undefined, { cwd, ui: allSuccess.ui }).then((result: any) => { successSettled = true; return result; });
		await successStarted.promise;
		if (successSettled) throw new Error("all-success foreground batch returned before the full batch settled");
		successGate.resolve();
		await successPromise;

		const backgroundGate = deferred<void>();
		const explicitBackground = harness(async (_params, _signal, _onUpdate, _ctx, dependencies) => {
			await backgroundGate.promise;
			return { content: [{ type: "text", text: "background done" }], details: { runId: dependencies.runId, label: "background", status: "completed", summary: "done", documents: [], tasks: [], activity: [], effectiveConcurrency: 1, requestedConcurrency: 1 } };
		});
		await startHarness(explicitBackground, cwd);
		const queued = await Promise.race([
			explicitBackground.tool?.execute("background", { background: true, tasks: [{ name: "background", prompt: "wait" }] }, undefined, undefined, { cwd, ui: explicitBackground.ui }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("explicit background run stopped returning immediately")), 100)),
		]);
		if (queued.details?.background !== true || queued.details?.status !== "queued") throw new Error("explicit background result contract regressed");
		const backgroundNotified = explicitBackground.waitForMessage((message) => message.details?.runId === queued.details.runId);
		backgroundGate.resolve();
		await backgroundNotified;
		if (explicitBackground.messages.filter(({ message }) => message.details?.runId === queued.details.runId).length !== 1) throw new Error("explicit background run did not send one final follow-up");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function verifyPublicUiWiring() {
	const cwd = mkdtempSync(join(tmpdir(), "herdr-extension-contract-"));
	try {
		const blockedDetails = {
			runId: "blocked-run", label: "reviews", status: "blocked", summary: "second needs input", documents: [],
			activity: [
				{ index: 0, name: "first", status: "completed", paneId: "w1:p1" },
				{ index: 1, name: "second", status: "blocked", paneId: "w1:p2" },
			],
		};
		const responding = harness(async () => ({ content: [{ type: "text", text: "needs input" }], details: blockedDetails }));
		await startHarness(responding, cwd);
		if (!responding.tool) throw new Error("herdr_subagents was not registered for UI wiring test");
		const renderedBlocked = responding.tool.renderResult({ content: [{ type: "text", text: "needs input" }], details: { agent: "explorer", status: "blocked", ok: false, summary: "Need input.", documents: [] } }, { isPartial: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(100).join("\n");
		if (!renderedBlocked.includes("blocked") || renderedBlocked.includes("failed")) throw new Error("single-task blocked result did not render its authoritative status");
		if (!responding.controlTool) throw new Error("herdr_subagents_control was not registered for UI wiring test");
		await responding.controlTool.execute("call", { action: "respond", runId: "blocked-run", answer: "main" }, undefined, undefined, { cwd, ui: responding.ui });
		if (!responding.renderedLines.some((line) => line.includes("second") && line.includes("blocked"))) throw new Error("blocked response did not refresh Fleet rows");
		if (!responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\r")?.consume) throw new Error("Fleet terminal input was not consumed while selecting");
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (responding.focusedPanes.join(",") !== "w1:p2") throw new Error("Enter did not focus the exact refreshed blocked pane");
		if (responding.terminalInput?.("x")?.consume) throw new Error("unrelated terminal input must pass through");

		let releaseFirst: ((value: unknown) => void) | undefined;
		let backgroundCalls = 0;
		const runningDetails = { runId: "active-run", label: "active", status: "running", summary: "working", documents: [], tasks: [], activity: [{ index: 0, name: "active task", status: "running", paneId: "w1:p3" }] };
		const background = harness(async (_params, _signal, onUpdate) => {
			backgroundCalls += 1;
			onUpdate?.({ content: [{ type: "text", text: "working" }], details: runningDetails });
			if (backgroundCalls > 1) return { content: [{ type: "text", text: "done" }], details: { ...runningDetails, status: "completed" } };
			return await new Promise((resolve) => { releaseFirst = resolve; });
		});
		await startHarness(background, cwd);
		if (!background.tool) throw new Error("herdr_subagents was not registered for queue wiring test");
		await background.tool.execute("first", { background: true, tasks: [{ name: "active task", prompt: "one" }] }, undefined, undefined, { cwd, ui: background.ui });
		const activeWidgetCalls = background.widgetCalls;
		await background.tool.execute("second", { background: true, tasks: [{ name: "queued task", prompt: "two" }] }, undefined, undefined, { cwd, ui: background.ui });
		if (background.widgetCalls !== activeWidgetCalls || !background.renderedLines.some((line) => line.includes("active task"))) throw new Error("queued background run replaced the active Fleet widget");
		releaseFirst?.({ content: [{ type: "text", text: "done" }], details: { ...runningDetails, status: "completed" } });
			await new Promise((resolve) => setTimeout(resolve, 10));

			let cancelledSignal: AbortSignal | undefined;
			const cancellable = harness(async (params, signal, _onUpdate, _ctx, dependencies) => {
				if (params.action === "cancel") {
					const result = await dependencies.cancelRun(params.runId);
					return { content: [{ type: "text", text: "cancelled" }], details: { action: "cancel", runId: params.runId, ...result } };
				}
				cancelledSignal = signal;
				return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			});
			await startHarness(cancellable, cwd);
			const cancellableRun = await cancellable.tool?.execute("cancellable", { background: true, tasks: [{ name: "cancel me", prompt: "wait" }] }, undefined, undefined, { cwd, ui: cancellable.ui });
			const cancelled = await cancellable.controlTool?.execute("cancel", { action: "cancel", runId: cancellableRun.details.runId }, undefined, undefined, { cwd, ui: cancellable.ui });
			if (!cancelledSignal?.aborted || cancelled?.details?.cancelled !== true) throw new Error("cancel control did not abort the selected live background run");

			const rejectedCwd = join(cwd, "rejected-background");
		mkdirSync(rejectedCwd, { recursive: true });
		const rejectedBackground = harness(async () => ({ content: [{ type: "text", text: "Unknown persona" }], details: { errorMessage: "Unknown persona" }, isError: true }));
		await startHarness(rejectedBackground, rejectedCwd);
		await rejectedBackground.tool?.execute("rejected", { background: true, tasks: [{ name: "invalid", prompt: "reject" }] }, undefined, undefined, { cwd: rejectedCwd, ui: rejectedBackground.ui });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const queueDirectory = join(rejectedCwd, ".pi", "herdr-subagents", "queue");
		if (existsSync(queueDirectory) && readdirSync(queueDirectory).some((name) => name.endsWith(".json"))) throw new Error("rejected background batch left a durable queue entry");

		let lateUpdate: ((response: any) => void) | undefined;
		const cleanupNotice = harness(async (_params, _signal, onUpdate) => {
			lateUpdate = onUpdate;
			return { content: [{ type: "text", text: "done" }], details: { status: "completed" } };
		});
		await startHarness(cleanupNotice, cwd);
		await cleanupNotice.tool?.execute("cleanup", { prompt: "inspect" }, undefined, undefined, { cwd, ui: cleanupNotice.ui });
		lateUpdate?.({ content: [{ type: "text", text: "Task results settled, but Herdr tab cleanup failed: busy" }], details: { status: "failed" } });
		if (!cleanupNotice.notifications.some(({ message, level }) => message.includes("cleanup failed") && level === "warning")) throw new Error("deferred foreground cleanup failure was not surfaced as a notification");

		const brokenRoot = join(cwd, "broken-recovery");
		mkdirSync(join(brokenRoot, ".pi", "herdr-subagents"), { recursive: true });
		writeFileSync(join(brokenRoot, ".pi", "herdr-subagents", "runs"), "not a directory");
		let resumedExecutions = 0;
		const recoveryFailure = harness(async () => {
			resumedExecutions += 1;
			return { content: [{ type: "text", text: "done" }], details: { runId: "after-recovery", label: "after recovery", status: "completed", summary: "done", documents: [], tasks: [], activity: [] } };
		});
		await startHarness(recoveryFailure, brokenRoot);
		await Promise.race([
			recoveryFailure.tool?.execute("after-recovery", { tasks: [{ name: "task", prompt: "continue" }] }, undefined, undefined, { cwd: brokenRoot, ui: recoveryFailure.ui }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("dispatcher stayed paused after recovery failure")), 100)),
		]);
		if (resumedExecutions !== 1 || !recoveryFailure.notifications.some(({ message }) => message.includes("recovery could not inspect"))) throw new Error("recovery failure did not resume dispatch and notify the user");

		const sessionAbortRoot = join(cwd, "session-abort");
		mkdirSync(sessionAbortRoot, { recursive: true });
		let retainedSignal: AbortSignal | undefined;
		const sessionAbort = harness(async (_params, signal) => {
			retainedSignal = signal;
			return { content: [{ type: "text", text: "done" }], details: { status: "completed" } };
		});
		await startHarness(sessionAbort, sessionAbortRoot);
		await sessionAbort.tool?.execute("session-abort", { prompt: "inspect" }, undefined, undefined, { cwd: sessionAbortRoot, ui: sessionAbort.ui });
		if (!retainedSignal || retainedSignal.aborted) throw new Error("execution did not retain a live parent-session signal");
		await sessionAbort.handlers.get("session_shutdown")?.({}, { cwd: sessionAbortRoot, ui: sessionAbort.ui });
		if (!retainedSignal.aborted) throw new Error("parent shutdown did not abort deferred cleanup signal");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

const originalHerdrEnv = process.env.HERDR_ENV;
const originalWorkspaceId = process.env.HERDR_WORKSPACE_ID;
const originalChild = process.env.PI_HERDR_SUBAGENTS_CHILD;
try {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	const outside = harness(async () => { throw new Error("unreachable"); });
	if (outside.tool || outside.commands.length || outside.handlers.size) throw new Error("Subagents registered outside Herdr");
	process.env.HERDR_ENV = "1";
	const missingWorkspace = harness(async () => { throw new Error("unreachable"); });
	if (missingWorkspace.tool || missingWorkspace.commands.length || missingWorkspace.handlers.size) throw new Error("Subagents registered without a Herdr workspace");
	process.env.HERDR_ENV = "0";
	process.env.HERDR_WORKSPACE_ID = "w1";
	const inactiveHerdr = harness(async () => { throw new Error("unreachable"); });
	if (inactiveHerdr.tool || inactiveHerdr.commands.length || inactiveHerdr.handlers.size) throw new Error("Subagents registered with HERDR_ENV=0");
	process.env.HERDR_ENV = "1";
	const inside = harness(async () => { throw new Error("unreachable"); });
	if (!inside.tool || !inside.controlTool || !inside.commands.includes("herdr-subagents") || !inside.handlers.has("session_start")) throw new Error("Subagents did not register both tools inside Herdr");
	process.env.PI_HERDR_SUBAGENTS_CHILD = "1";
	const child = harness(async () => { throw new Error("unreachable"); });
	if (child.tool || child.commands.length || child.handlers.size) throw new Error("Subagents registered inside a child Agent");
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	await verifyPublicUiWiring();
	await verifyForegroundFailureHandoff();
} finally {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
	if (originalWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = originalWorkspaceId;
	if (originalChild === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	else process.env.PI_HERDR_SUBAGENTS_CHILD = originalChild;
}

export default function (_pi: ExtensionAPI) {
	const tools = new Map<string, Record<string, any>>();
	const pi = {
		on() {},
		registerTool(definition: Record<string, any>) { tools.set(definition.name, definition); },
		registerCommand() {},
		sendMessage() {},
	};

	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
	const previousChild = process.env.PI_HERDR_SUBAGENTS_CHILD;
	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "w1";
		delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		registerHerdrSubagents(pi as never, { herdr: {} as never });
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
		if (previousChild === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		else process.env.PI_HERDR_SUBAGENTS_CHILD = previousChild;
	}
	const tool = tools.get("herdr_subagents");
	const controlTool = tools.get("herdr_subagents_control");
	if (!tool || !controlTool) throw new Error("Herdr execution and control tools were not both registered");
	const schema = tool.parameters as Record<string, any>;
	if (schema.type !== "object" || schema.anyOf || schema.oneOf) throw new Error("herdr_subagents parameters must be one flat object schema");
	for (const name of ["tasks", "label", "concurrency", "background"]) {
		if (!schema.properties?.[name]) throw new Error(`schema is missing property '${name}'`);
		if (!schema.properties[name].description) throw new Error(`schema property '${name}' has no description`);
	}
	if (!schema.required?.includes("tasks")) throw new Error("herdr_subagents tasks must be required");
	const normalized = tool.prepareArguments?.({ prompt: "inspect", agent: "explorer", label: "probe", background: true });
	if (normalized?.tasks?.length !== 1 || normalized.tasks[0].name !== "probe" || normalized.tasks[0].prompt !== "inspect" || normalized.tasks[0].agent !== "explorer" || normalized.background !== true) {
		throw new Error("legacy single-task arguments were not normalized into a one-item background run");
	}
	for (const name of ["name", "prompt", "agent", "model"]) {
		const property = schema.properties.tasks.items.properties[name];
		if (!property?.description) throw new Error(`nested task property '${name}' has no description`);
	}
	const controlSchema = controlTool.parameters as Record<string, any>;
	for (const name of ["action", "runId", "answer", "task", "prompt"]) {
		if (!controlSchema.properties?.[name]?.description) throw new Error(`control schema property '${name}' is missing or undocumented`);
	}
	if (!controlSchema.required?.includes("action")) throw new Error("herdr_subagents_control action must be required");
	const controlActions = controlSchema.properties.action.enum ?? controlSchema.properties.action.anyOf?.map((entry: Record<string, unknown>) => entry.const);
	if (!controlActions?.includes("status")) throw new Error("herdr_subagents_control action enum must include status");
	if (!/status/.test(controlSchema.properties.runId.description)) throw new Error("control runId description must document status");
	if (!/Use status for one run/.test(controlTool.description)) throw new Error("control tool description must distinguish status from history");
	if (!/Foreground calls wait/.test(tool.description) || !/Explicit background calls always return a run ID immediately/.test(tool.description)) {
		throw new Error("tool description does not distinguish foreground and background execution");
	}
}
