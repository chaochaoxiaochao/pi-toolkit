import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { BackgroundTasks } from "../src/background-tasks.ts";

async function waitFor(check) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Real process did not reach expected state within 5 seconds");
		await delay(20);
	}
}
function alive(pid) {
	try {
		process.kill(pid, 0);
		// A reaped parent can temporarily leave a zombie child owned by PID 1.
		if (existsSync(`/proc/${pid}/stat`) && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z ")) return false;
		return true;
	} catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

test("native backend starts immediately and executes heredoc/PID/exit-file checks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-bg-process-"));
	const completed = [];
	const tasks = new BackgroundTasks({ operations: createLocalBashOperations(), onComplete: (task) => completed.push(task) });
	try {
		writeFileSync(join(root, "build.log"), "> Task :compile\nnoise\nBUILD SUCCESSFUL\n");
		writeFileSync(join(root, "build.exit"), "0\n");
		const task = tasks.start({ command: `sleep 1; python3 - <<'PY'
from pathlib import Path
p=Path('build.log')
lines=p.read_text(errors='replace').splitlines()
s=[x for x in lines if x.startswith('> Task') or 'BUILD SUCCESS' in x]
print('\\n'.join(s[-35:])); print('log bytes:',p.stat().st_size)
PY
ps -p $$ -o pid,etime; test ! -f build.exit || cat build.exit` }, root);
		assert.equal(task.status, "running");
		const other = tasks.start({ command: "printf concurrent" }, root);
		await waitFor(() => tasks.get(other.id).status !== "running");
		assert.equal(tasks.get(task.id).status, "running", "other work completed before the sleeping job");
		await waitFor(() => tasks.get(task.id).status !== "running");
		assert.equal(tasks.get(task.id).status, "succeeded");
		assert.match(tasks.output(task.id).output, /> Task :compile\nBUILD SUCCESSFUL\nlog bytes:/);
		assert.equal(completed.length, 2);
	} finally { await tasks.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const stop of ["timeout", "cancel", "shutdown"]) {
	test(`native ${stop} stops silent shell and its waiting child`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-bg-tree-"));
		const tasks = new BackgroundTasks({ operations: createLocalBashOperations() });
		let pids = [];
		try {
			const task = tasks.start({
				command: `echo $$ > shell.pid; sleep 300 & echo $! > child.pid; wait`,
				timeout: stop === "timeout" ? 1 : 30,
			}, root);
			await waitFor(() => existsSync(join(root, "child.pid")));
			pids = ["shell.pid", "child.pid"].map((file) => Number(readFileSync(join(root, file), "utf8").trim()));
			if (stop === "shutdown") await tasks.shutdown();
			else if (stop === "cancel") await tasks.cancel(task.id);
			else await waitFor(() => tasks.get(task.id).status !== "running");
			await waitFor(() => pids.every((pid) => !alive(pid)));
			assert.equal(tasks.get(task.id).status, stop === "timeout" ? "timed_out" : "cancelled");
		} finally { await tasks.shutdown(); rmSync(root, { recursive: true, force: true }); }
	});
}

test("silent busy loop times out without any agent polling or output", async () => {
	const tasks = new BackgroundTasks({ operations: createLocalBashOperations() });
	try {
		const job = tasks.start({ command: "while :; do :; done", timeout: 1 }, process.cwd());
		await waitFor(() => tasks.get(job.id).status !== "running");
		assert.equal(tasks.get(job.id).status, "timed_out");
		assert.equal(tasks.output(job.id).output, "");
	} finally { await tasks.shutdown(); }
});

test("native large output truncates display, then stops at the 32 MiB disk budget", async () => {
	const tasks = new BackgroundTasks({ operations: createLocalBashOperations() });
	try {
		const job = tasks.start({ command: "python3 -c \"import sys; sys.stdout.buffer.write(b'x' * (40 * 1024 * 1024))\"" }, process.cwd());
		await waitFor(() => tasks.get(job.id).status !== "running");
		const result = tasks.output(job.id);
		assert.equal(result.status, "output_limit");
		assert.equal(result.bytes, 32 * 1024 * 1024);
		assert.equal(result.capture_complete, false);
		assert.equal(result.truncated, true);
		assert.ok(result.truncation.outputBytes <= 51200);
		assert.ok(Buffer.byteLength(result.output) < 1024 * 1024 + 100);
	} finally { await tasks.shutdown(); }
});
