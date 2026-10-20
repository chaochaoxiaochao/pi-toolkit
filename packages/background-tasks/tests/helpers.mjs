import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTasks } from "../src/background-tasks.ts";

export class FakeClock {
	time = 1000;
	next = 0;
	timers = new Map();
	now = () => this.time;
	setTimeout = (callback, delay) => {
		const id = ++this.next;
		this.timers.set(id, { at: this.time + delay, callback });
		return id;
	};
	clearTimeout = (id) => this.timers.delete(id);
	advance(ms) {
		const target = this.time + ms;
		for (;;) {
			const due = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.time = due[1].at;
			this.timers.delete(due[0]);
			due[1].callback();
		}
		this.time = target;
	}
}

export function fixture(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
	const clock = new FakeClock();
	const calls = [];
	const completed = [];
	const operations = {
		exec(command, cwd, opts) {
			return new Promise((resolve, reject) => {
				calls.push({ command, cwd, ...opts, resolve: (exitCode = 0) => resolve({ exitCode }), reject });
			});
		},
	};
	const tasks = new BackgroundTasks({ operations, clock, logRoot: root, onComplete: (task) => completed.push(task), ...options });
	return {
		root, clock, calls, completed, tasks, operations,
		async close() {
			for (const call of calls) call.resolve();
			await tasks.shutdown();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
