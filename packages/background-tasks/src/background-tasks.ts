import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { TaskLog, type LogWrite, type OutputView } from "./output.ts";

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "output_limit";
export interface TaskSnapshot {
	id: string;
	status: TaskStatus;
	description: string;
	cwd: string;
	started_at: number;
	ended_at?: number;
	timeout: number;
	elapsed_seconds: number;
	log_path: string;
	bytes: number;
	capture_complete: boolean;
	exit_code?: number;
	reason?: string;
}
export interface StartParams {
	command: string;
	description?: string;
	cwd?: string;
	timeout?: number;
}
interface Task {
	data: TaskSnapshot;
	log: TaskLog;
	controller: AbortController;
	timer?: unknown;
	done: Promise<void>;
	stop?: Exclude<TaskStatus, "running" | "succeeded">;
	captureLost: boolean;
}
export interface TaskList {
	tasks: TaskSnapshot[];
	running: number;
	total: number;
	omitted: number;
}

export function summary(text: string, max = 200): string {
	return Array.from(stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f\uFFF9-\uFFFB]/g, " ").trim()).slice(0, max).join("");
}
export function errorText(error: unknown): string {
	return summary(error instanceof Error ? error.message : String(error), 500);
}

/** Session-owned jobs; tool calls only transfer control, never own the job signal. */
export class BackgroundTasks {
	private readonly operations: BashOperations;
	readonly clock: Clock;
	private readonly onComplete: (task: TaskSnapshot) => void;
	private readonly onChange: () => void;
	private readonly logRoot: string;
	private readonly logWrite?: LogWrite;
	private readonly taskBytes: number;
	private readonly sessionBytes: number;
	private readonly tasks = new Map<string, Task>();
	private directory?: string;
	private bytes = 0;
	private closed = false;
	private shutdownPromise?: Promise<void>;

	constructor(options: {
		operations: BashOperations;
		clock?: Clock;
		onComplete?: (task: TaskSnapshot) => void;
		onChange?: () => void;
		logRoot?: string;
		logWrite?: LogWrite;
		limits?: { taskBytes: number; sessionBytes: number };
	}) {
		this.operations = options.operations;
		this.clock = options.clock ?? systemClock;
		this.onComplete = options.onComplete ?? (() => {});
		this.onChange = options.onChange ?? (() => {});
		this.logRoot = options.logRoot ?? tmpdir();
		this.logWrite = options.logWrite;
		this.taskBytes = options.limits?.taskBytes ?? 32 * 1024 * 1024;
		this.sessionBytes = options.limits?.sessionBytes ?? 256 * 1024 * 1024;
		if (this.taskBytes <= 0 || this.sessionBytes <= 0) throw new Error("Log limits must be positive");
	}

	start(params: StartParams, sessionCwd: string): TaskSnapshot {
		if (this.closed) throw new Error("Background tasks session is closed");
		if (typeof params.command !== "string" || !params.command.trim()) throw new Error("start requires a non-empty command");
		const timeout = params.timeout === undefined ? 1800 : params.timeout;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new Error("timeout must be an integer from 1 to 7200 seconds (default 1800)");
		if (params.description !== undefined && typeof params.description !== "string") throw new Error("description must be a string");
		if (params.cwd !== undefined && (typeof params.cwd !== "string" || !params.cwd.trim())) throw new Error("cwd must be a non-empty directory path");
		const cwd = resolve(sessionCwd, params.cwd ?? ".");
		try {
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch (error) { throw new Error(`Invalid working directory: ${errorText(error)}`); }
		if (this.running() >= 2) throw new Error("At most two background tasks may be running; cancel one or wait for completion");
		if (this.bytes >= this.sessionBytes) throw new Error("Session log budget exhausted; start a new session to reset it");
		this.directory ??= mkdtempSync(join(this.logRoot, "pi-background-tasks-"));
		let id: string;
		do { id = `bg-${randomUUID().replace(/-/g, "").slice(0, 12)}`; } while (this.tasks.has(id));
		const log = new TaskLog(join(this.directory, `${id}.log`), this.logWrite);
		const task: Task = {
			data: {
				id, status: "running", description: summary(params.description || params.command.split("\n", 1)[0]), cwd,
				started_at: this.clock.now(), timeout, elapsed_seconds: 0, log_path: log.path,
				bytes: 0, capture_complete: false,
			},
			log, controller: new AbortController(), done: Promise.resolve(), captureLost: false,
		};
		// This path is synchronous: reserve the slot before any execution can await.
		this.tasks.set(id, task);
		task.timer = this.clock.setTimeout(() => this.stop(task, "timed_out", `Runtime limit of ${timeout} seconds reached`), timeout * 1000);
		const accepted = this.snapshot(task);
		task.done = this.run(task, params.command);
		this.changed();
		return accepted;
	}

	get(id: string): TaskSnapshot { return this.snapshot(this.find(id)); }

	list(): TaskList {
		const all = [...this.tasks.values()];
		const active = all.filter((task) => task.data.status === "running");
		const ended = all.filter((task) => task.data.status !== "running").reverse().slice(0, 20);
		return { tasks: [...active, ...ended].map((task) => this.snapshot(task)), running: active.length, total: all.length, omitted: all.length - active.length - ended.length };
	}

	output(id: string): TaskSnapshot & OutputView {
		const task = this.find(id);
		try { return { ...this.snapshot(task), ...task.log.read() }; }
		catch (error) {
			this.captureFailure(task, `Cannot read task log: ${errorText(error)}`);
			throw new Error(`Cannot read task log: ${errorText(error)}`);
		}
	}

	async cancel(id: string): Promise<TaskSnapshot> {
		const task = this.find(id);
		this.stop(task, "cancelled", "Cancelled by request");
		await task.done;
		return this.snapshot(task);
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closed = true;
		for (const task of this.tasks.values()) this.stop(task, "cancelled", "Session closed");
		this.shutdownPromise = Promise.all([...this.tasks.values()].map((task) => task.done)).then(() => {
			if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		});
		return this.shutdownPromise;
	}

	private async run(task: Task, command: string): Promise<void> {
		try {
			const { exitCode } = await this.operations.exec(command, task.data.cwd, {
				signal: task.controller.signal,
				onData: (data) => this.append(task, data),
			});
			if (exitCode !== null) task.data.exit_code = exitCode;
			if (!task.stop && exitCode !== 0) this.stop(task, "failed", `Command exited with ${exitCode === null ? "no exit code" : `code ${exitCode}`}`);
		} catch (error) {
			this.stop(task, "failed", errorText(error));
		} finally {
			if (task.timer !== undefined) this.clock.clearTimeout(task.timer);
			task.timer = undefined;
			try { task.log.finish(); }
			catch (error) {
				this.captureFailure(task, `Cannot close task log: ${errorText(error)}`);
			}
			task.data.status = task.stop ?? "succeeded";
			task.data.ended_at = this.clock.now();
			task.data.capture_complete = !task.captureLost;
			this.changed();
			if (!this.closed) {
				try { this.onComplete(this.snapshot(task)); }
				catch (error) { console.error(`Background completion notification failed: ${errorText(error)}`); }
			}
		}
	}

	private append(task: Task, data: Buffer): void {
		if (task.captureLost || task.data.status !== "running" || data.length === 0) return;
		const remaining = Math.max(0, Math.min(this.taskBytes - task.log.bytes, this.sessionBytes - this.bytes));
		const before = task.log.bytes;
		try { if (remaining > 0) task.log.append(data.subarray(0, remaining)); }
		catch (error) {
			this.captureFailure(task, `Cannot write task log: ${errorText(error)}`);
		} finally { this.bytes += task.log.bytes - before; }
		if (data.length >= remaining) {
			task.captureLost = true;
			this.stop(task, "output_limit", `Log output limit reached (task ${this.taskBytes} bytes; session ${this.sessionBytes} bytes)`);
		}
	}

	private captureFailure(task: Task, reason: string): void {
		task.captureLost = true;
		if (task.stop || task.data.status !== "running") {
			task.data.reason = summary(`${task.data.reason ? `${task.data.reason}; ` : ""}${reason}`, 500);
		}
		this.stop(task, "failed", reason);
	}

	private stop(task: Task, status: NonNullable<Task["stop"]>, reason: string): void {
		if (task.data.status !== "running" || task.stop) return;
		task.stop = status;
		task.data.reason = summary(reason, 500);
		task.controller.abort();
	}

	private running(): number { return [...this.tasks.values()].filter((task) => task.data.status === "running").length; }
	private find(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error("Unknown background task ID in this session");
		return task;
	}
	private snapshot(task: Task): TaskSnapshot {
		return { ...task.data, capture_complete: task.data.capture_complete && !task.captureLost, bytes: task.log.bytes, elapsed_seconds: Math.max(0, ((task.data.ended_at ?? this.clock.now()) - task.data.started_at) / 1000) };
	}
	private changed(): void {
		if (this.closed) return;
		try { this.onChange(); }
		catch (error) { console.error(`Background task display failed: ${errorText(error)}`); }
	}
}
