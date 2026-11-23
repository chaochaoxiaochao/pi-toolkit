import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { finished } from "node:stream/promises";
import { CLIENT_TIMEOUT_MS, MAX_LINE_BYTES, encode, isRecord as isProtocolRecord } from "../guest/protocol.mjs";
import type { CageProfile } from "./profile.ts";

const READY = '{"type":"ready","version":1}';
const MAX_PREAMBLE_BYTES = 128 * 1024;
const STARTUP_MS = 10_000;
const METADATA_MS = 35_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return isProtocolRecord(value);
}

export type CageRequest = { op: "status" | "models" } | { op: "close"; sessionId: string } | {
	op: "turn";
	sessionId: string;
	model: object;
	context: { messages: unknown[] };
	options: { timeoutMs?: number };
};

function launch(profile: CageProfile, command: readonly string[]) {
	try {
		if (!statSync(profile.config).isFile()) throw new Error();
		accessSync(profile.config, constants.R_OK);
		if (!statSync(profile.executable).isFile()) throw new Error();
		accessSync(profile.executable, constants.X_OK);
	} catch {
		throw new Error("Check the Cage executable and profile paths in claude-cage.json");
	}
	const env: NodeJS.ProcessEnv = { CLAUDE_CAGE_CONFIG: profile.config };
	for (const name of [
		"HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
		"XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS",
	]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return spawn(profile.executable, ["run", "--workdir", "/tmp", "--", ...command], {
		env, cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"],
	});
}

async function waitForClose(child: ChildProcessWithoutNullStreams, closed: Promise<number | null>) {
	child.stdin.end();
	child.stdout.resume();
	const terminate = setTimeout(() => child.kill("SIGTERM"), 300);
	const kill = setTimeout(() => child.kill("SIGKILL"), 650);
	let giveUp: NodeJS.Timeout | undefined;
	try {
		await Promise.race([closed, new Promise<void>((resolve) => { giveUp = setTimeout(resolve, 1_000); })]);
	} finally {
		clearTimeout(terminate);
		clearTimeout(kill);
		clearTimeout(giveUp);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.unref();
	}
}

async function runProxy<T>(
	profile: CageProfile,
	command: readonly string[],
	signal: AbortSignal | undefined,
	run: (io: {
		child: ChildProcessWithoutNullStreams;
		signal: AbortSignal;
		closed: Promise<number | null>;
		deadline: (ms: number, message: string) => void;
	}) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const child = launch(profile, command);
	const failure = new AbortController();
	const active = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal;
	const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
	let timer: NodeJS.Timeout | undefined;
	let hasStderr = false;
	// Drain diagnostics so they cannot block the proxy. Do not relay guest stderr,
	// which can contain credentials, escape codes, or arbitrary retry keywords.
	child.stderr.on("data", () => { hasStderr = true; });
	child.stderr.on("error", () => {});
	child.on("error", () => failure.abort(new Error("Could not launch the configured Cage executable")));
	const abort = () => {
		child.stdin.end();
		child.stdout.destroy();
	};
	active.addEventListener("abort", abort, { once: true });
	function deadline(ms: number, message: string) {
		clearTimeout(timer);
		timer = setTimeout(() => failure.abort(new Error(message)), ms);
	}
	// A proxy may write a complete response and exit while the pipe is closing.
	// Let stdout or the deadline decide whether the response completed.
	child.stdin.on("error", () => {});
	try {
		const result = await run({ child, signal: active, closed, deadline });
		active.throwIfAborted();
		return result;
	} catch (error) {
		const reason = active.aborted ? active.reason : error;
		if (signal?.aborted || !hasStderr) throw reason;
		const message = reason instanceof Error ? reason.message : "Cage command failed";
		throw new Error(`${message} (Cage wrote to stderr; inspect the configured profile)`);
	} finally {
		clearTimeout(timer);
		active.removeEventListener("abort", abort);
		await waitForClose(child, closed);
	}
}

function parseFrame(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		throw new Error("Invalid JSON from the Cage proxy");
	}
}

export function withAbort<T>(task: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function requestCage(profile: CageProfile, request: CageRequest, options: {
	signal?: AbortSignal;
	onSubmit?: () => void;
	onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
	startupMs?: number;
	responseMs?: number;
} = {}): Promise<unknown> {
	const id = randomUUID();
	const input = encode({ ...request, id });
	return runProxy(profile, ["node", profile.clientPath], options.signal, async ({ child, signal, deadline }) => {
		const closing = request.op === "close";
		deadline(options.startupMs ?? (closing ? 4_000 : STARTUP_MS), "Cage proxy did not become ready before its deadline");
		let ready = false;
		let preambleBytes = 0;
		let lineBytes = 0;
		let parts: Buffer[] = [];
		for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
			signal.throwIfAborted();
			let start = 0;
			while (start < chunk.length) {
				const newline = chunk.indexOf(10, start);
				const end = newline < 0 ? chunk.length : newline;
				lineBytes += end - start;
				if (lineBytes > MAX_LINE_BYTES || (!ready && preambleBytes + lineBytes > MAX_PREAMBLE_BYTES)) {
					throw new Error(ready ? "Cage response line is too large" : "Cage proxy preamble is too large");
				}
				parts.push(chunk.subarray(start, end));
				if (newline < 0) break;
				const line = Buffer.concat(parts, lineBytes).toString("utf8");
				start = newline + 1;
				parts = [];
				preambleBytes += ready ? 0 : lineBytes + 1;
				lineBytes = 0;
				if (!ready) {
					if (line !== READY) continue;
					ready = true;
					deadline(options.responseMs ?? (request.op === "turn" ? CLIENT_TIMEOUT_MS : closing ? 4_000 : METADATA_MS),
						"Cage request did not complete before its deadline");
					child.stdin.write(input);
					options.onSubmit?.();
					continue;
				}
				const frame = parseFrame(line);
				if (!isRecord(frame) || frame.id !== id) throw new Error("Cage response did not match this request");
				if (frame.type === "error" && typeof frame.message === "string") {
					throw new Error(frame.message);
				}
				if (request.op !== "turn" && frame.type === "value" && Object.hasOwn(frame, "value")) {
					child.stdin.end();
					return frame.value;
				}
				if (request.op !== "turn" || frame.type !== "event" || !isRecord(frame.event)) {
					throw new Error("Unexpected response from the Cage proxy");
				}
				if (frame.event.type === "done" || frame.event.type === "error") {
					child.stdin.end();
					await withAbort(options.onEvent?.(frame.event), signal);
					return frame.event;
				}
				await withAbort(options.onEvent?.(frame.event), signal);
			}
		}
		signal.throwIfAborted();
		throw new Error(ready ? "Cage proxy disconnected before a final response" : "Cage proxy exited before its ready line");
	});
}

export async function runCageSetupStep(
	profile: CageProfile, script: string, input: Buffer | undefined, signal: AbortSignal, timeoutMs: number,
): Promise<string> {
	return runProxy(profile, ["bash", "-c", script], signal, async ({ child, signal: active, closed, deadline }) => {
		deadline(timeoutMs, "Cage setup step did not complete before its deadline");
		child.stdin.end(input);
		const chunks: Buffer[] = [];
		let bytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= MAX_PREAMBLE_BYTES) chunks.push(chunk);
			else child.stdout.destroy(new Error("Cage setup output is too large"));
		});
		await finished(child.stdout, { signal: active, cleanup: true });
		if (await withAbort(closed, active) !== 0) throw new Error("Cage setup command failed");
		return Buffer.concat(chunks).toString("utf8");
	});
}
