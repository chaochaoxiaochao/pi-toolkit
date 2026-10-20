import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackgroundTasks } from "../src/background-tasks.ts";
import { fixture, flush } from "./helpers.mjs";

test("start returns while execution is pending; two tasks own independent slots", async () => {
	const f = fixture();
	try {
		const first = f.tasks.start({ command: "sleep 60; printf done" }, f.root);
		const second = f.tasks.start({ command: "other", timeout: 60 }, f.root);
		assert.equal(first.status, "running");
		assert.equal(first.timeout, 1800);
		assert.notEqual(first.id, second.id);
		assert.equal(f.calls.length, 2);
		assert.throws(() => f.tasks.start({ command: "third" }, f.root), /two|2.*running/i);
		f.calls[0].onData(Buffer.from("hello\n"));
		assert.equal(f.tasks.output(first.id).output, "hello\n");
		f.calls[0].resolve();
		await flush();
		assert.equal(f.tasks.get(first.id).status, "succeeded");
		assert.equal(f.completed.length, 1);
		assert.equal(f.tasks.list().running, 1);
		assert.equal(f.tasks.get(first.id).capture_complete, true);
		assert.equal(readFileSync(first.log_path, "utf8"), "hello\n");
	} finally { await f.close(); }
});

test("timeout records its cause, aborts without a model, and retains the slot until cleanup", async () => {
	const f = fixture();
	try {
		const a = f.tasks.start({ command: "loop", timeout: 1 }, f.root);
		f.tasks.start({ command: "second" }, f.root);
		f.clock.advance(1000);
		assert.equal(f.calls[0].signal.aborted, true);
		assert.equal(f.tasks.get(a.id).status, "running");
		assert.throws(() => f.tasks.start({ command: "third" }, f.root), /two|2.*running/i);
		const cancel = f.tasks.cancel(a.id);
		f.calls[0].reject(new Error("aborted"));
		await cancel;
		assert.equal(f.tasks.get(a.id).status, "timed_out");
		assert.equal(f.completed.length, 1);
		await f.tasks.cancel(a.id);
		assert.equal(f.completed.length, 1);
	} finally { await f.close(); }
});

test("invalid inputs have no execution or log side effects", async () => {
	const f = fixture();
	try {
		for (const timeout of [0, -1, 1.5, 7201, Infinity, NaN, "30"]) {
			assert.throws(() => f.tasks.start({ command: "x", timeout }, f.root), /timeout/i);
		}
		assert.throws(() => f.tasks.start({ command: " " }, f.root), /command/i);
		assert.throws(() => f.tasks.start({ command: "x", cwd: "missing" }, f.root), /directory/i);
		assert.throws(() => f.tasks.get("not-mine"), /unknown/i);
		assert.equal(f.calls.length, 0);
		assert.equal(f.tasks.list().total, 0);
	} finally { await f.close(); }
});

test("shutdown is idempotent, suppresses notifications and removes only owned logs", async () => {
	const f = fixture();
	const task = f.tasks.start({ command: "pending" }, f.root);
	const shutdown = f.tasks.shutdown();
	assert.equal(f.calls[0].signal.aborted, true);
	f.calls[0].resolve();
	await shutdown;
	assert.equal(f.completed.length, 0);
	assert.equal(f.clock.timers.size, 0);
	assert.equal(existsSync(task.log_path), false);
	assert.equal(existsSync(f.root), true);
	assert.throws(() => f.tasks.start({ command: "x" }, f.root), /closed/i);
	await f.close();
});

for (const mode of ["task", "session"]) {
	test(`${mode} byte budget stops only the overflowing task and marks captured output incomplete`, async () => {
		const f = fixture({ limits: { taskBytes: mode === "task" ? 4 : 100, sessionBytes: mode === "session" ? 4 : 100 } });
		try {
			const job = f.tasks.start({ command: "large" }, f.root);
			f.calls[0].onData(Buffer.from("1234567"));
			assert.equal(f.calls[0].signal.aborted, true);
			f.calls[0].reject(new Error("aborted"));
			await flush();
			const result = f.tasks.output(job.id);
			assert.equal(result.status, "output_limit");
			assert.equal(result.output, "1234");
			assert.equal(result.bytes, 4);
			assert.equal(result.capture_complete, false);
			assert.equal(f.completed.length, 1);
			if (mode === "session") assert.throws(() => f.tasks.start({ command: "more" }, f.root), /budget/i);
			else assert.equal(f.tasks.start({ command: "more" }, f.root).status, "running");
		} finally { await f.close(); }
	});
}

test("log write failure aborts the job and reports bounded failure without escaping onData", async () => {
	const f = fixture({ logWrite() { throw new Error("disk full " + "x".repeat(10000)); } });
	try {
		const job = f.tasks.start({ command: "write" }, f.root);
		assert.doesNotThrow(() => f.calls[0].onData(Buffer.from("hello")));
		assert.equal(f.calls[0].signal.aborted, true);
		f.calls[0].reject(new Error("aborted"));
		await flush();
		assert.equal(f.tasks.get(job.id).status, "failed");
		assert.match(f.tasks.get(job.id).reason, /disk full/);
		assert.ok(f.tasks.get(job.id).reason.length <= 500);
		assert.equal(f.tasks.get(job.id).capture_complete, false);
	} finally { await f.close(); }
});

test("nonzero exit, null exit and spawn errors are final failures; first stop reason wins", async () => {
	const f = fixture();
	try {
		for (const outcome of [12, null, "spawn failed"]) {
			const task = f.tasks.start({ command: "failure" }, f.root);
			const call = f.calls.at(-1);
			if (typeof outcome === "string") call.reject(new Error(outcome));
			else call.resolve(outcome);
			await flush();
			assert.equal(f.tasks.get(task.id).status, "failed");
		}
		const job = f.tasks.start({ command: "cancel race", timeout: 1 }, f.root);
		const cancelled = f.tasks.cancel(job.id);
		f.clock.advance(1000);
		f.calls.at(-1).resolve(0);
		assert.equal((await cancelled).status, "cancelled");
		assert.equal(f.completed.length, 4);
	} finally { await f.close(); }
});

test("history is bounded in list, but older task outputs remain addressable; previews are safe", async () => {
	const f = fixture();
	try {
		let first;
		for (let i = 0; i < 25; i++) {
			const job = f.tasks.start({ command: "x".repeat(10000), description: "\u001b]0;bad\u0007hello\n" + "中".repeat(300), timeout: 7200 }, f.root);
			first ??= job;
			assert.ok(Array.from(job.description).length <= 200);
			assert.ok(!/[\x00-\x1f]/.test(job.description));
			f.calls.at(-1).resolve();
			await flush();
		}
		assert.equal(f.tasks.list().tasks.length, 20);
		assert.equal(f.tasks.list().total, 25);
		assert.equal(f.tasks.list().omitted, 5);
		assert.equal(f.tasks.output(first.id).status, "succeeded");
	} finally { await f.close(); }
});

test("explicit null timeout is not an unlimited/default timeout", async () => {
	const f = fixture();
	try { assert.throws(() => f.tasks.start({ command: "x", timeout: null }, f.root), /timeout/i); }
	finally { await f.close(); }
});

test("a log failure while cancellation drains output preserves the stop cause and reports lost capture", async () => {
	const f = fixture({ logWrite() { throw new Error("disk full while draining"); } });
	try {
		const job = f.tasks.start({ command: "write" }, f.root);
		const cancel = f.tasks.cancel(job.id);
		f.calls[0].onData(Buffer.from("buffered output"));
		f.calls[0].reject(new Error("aborted"));
		const result = await cancel;
		assert.equal(result.status, "cancelled");
		assert.equal(result.capture_complete, false);
		assert.match(result.reason, /disk full while draining/);
	} finally { await f.close(); }
});

test("short OS writes preserve all UTF-8 output in owner-only logs", async () => {
	const f = fixture({ logWrite: (fd, data) => writeSync(fd, data.subarray(0, 2)) });
	try {
		const job = f.tasks.start({ command: "unicode" }, f.root);
		f.calls[0].onData(Buffer.from("中文🙂\n"));
		f.calls[0].resolve();
		await flush();
		assert.equal(f.tasks.output(job.id).output, "中文🙂\n");
		assert.equal(statSync(job.log_path).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(job.log_path)).mode & 0o777, 0o700);
	} finally { await f.close(); }
});

test("log creation failure rejects before execution; missing active logs abort visibly", async () => {
	const f = fixture();
	const invalid = new BackgroundTasks({ operations: f.operations, logRoot: join(f.root, "missing") });
	try {
		assert.throws(() => invalid.start({ command: "x" }, f.root), /ENOENT/);
		assert.equal(f.calls.length, 0);
		const job = f.tasks.start({ command: "pending" }, f.root);
		unlinkSync(job.log_path);
		assert.throws(() => f.tasks.output(job.id), /Cannot read/);
		assert.equal(f.calls[0].signal.aborted, true);
		f.calls[0].reject(new Error("aborted"));
		await flush();
		assert.equal(f.tasks.get(job.id).status, "failed");
		assert.equal(f.tasks.get(job.id).capture_complete, false);
	} finally { await invalid.shutdown(); await f.close(); }
});
