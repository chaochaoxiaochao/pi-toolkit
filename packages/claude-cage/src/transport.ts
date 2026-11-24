import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, join } from "node:path";
import {
	CLIENT_TIMEOUT_MS, MAX_FRAME_BYTES, PROTOCOL_VERSION, encodeFrame, isRecord as isProtocolRecord,
	readFrames, writeEncodedFrame, writeFrame,
} from "../guest/protocol.mjs";
import type { CageProfile } from "./profile.ts";

const MAX_PREAMBLE_BYTES = 128 * 1024;
const STARTUP_MS = 10_000;
const METADATA_MS = 35_000;
const CLEANUP_MS = 12_000;
const READY = JSON.stringify({ type: "ready", version: PROTOCOL_VERSION });
const FATAL_PREFIX = "Claude Cage connection failed and is closed.";
const RELOAD_SUFFIX = "Run /reload before using Claude Cage again.";

export type CageRequest = { op: "status" | "models" } | {
	op: "turn";
	model: object;
	context: { messages: unknown[] };
	options: { timeoutMs?: number };
};

export type RequestOptions = {
	signal?: AbortSignal;
	onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
};

type TranscriptBase = { hash: string; digests: string[] };

type Remaining = AsyncIterable<Buffer>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return isProtocolRecord(value);
}

function fatalError(detail: string): Error {
	return new Error(`${FATAL_PREFIX} ${detail.replace(/[\x00-\x1f\x7f]/g, " ").trim()} ${RELOAD_SUFFIX}`);
}

function connectionFailure(value: unknown): Error & { connectionFatal: true } {
	const error = value instanceof Error ? value : new Error(String(value));
	(error as Error & { connectionFatal?: boolean }).connectionFatal = true;
	return error as Error & { connectionFatal: true };
}

export function isFatalConnectionError(value: unknown): boolean {
	const message = value instanceof Error ? value.message : String(value);
	return message.startsWith(FATAL_PREFIX);
}

function checkedFile(path: string, mode: number) {
	if (!statSync(path).isFile()) throw new Error();
	accessSync(path, mode);
}

function hostEnvironment(profile: CageProfile): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { CLAUDE_CAGE_CONFIG: profile.config };
	for (const name of [
		"HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
		"XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS",
	]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return env;
}

function launchService(profile: CageProfile): ChildProcessWithoutNullStreams {
	try {
		checkedFile(profile.config, constants.R_OK);
		checkedFile(profile.executable, constants.X_OK);
	} catch {
		throw new Error("Check the Cage executable and profile paths in claude-cage.json");
	}
	const nodePath = join(dirname(profile.servicePath), "node");
	const command = [
		"env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", "-u", "LD_PRELOAD", "-u", "LD_LIBRARY_PATH", "-u", "LD_AUDIT",
		nodePath, "--experimental-transform-types", profile.servicePath, "--stdio",
	];
	return spawn(profile.executable, ["run", "--workdir", "/tmp", "--", ...command], {
		env: hostEnvironment(profile), cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"],
	});
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function transcriptPlan(messages: unknown[], base: TranscriptBase | undefined) {
	const digests = messages.map(digest);
	const append = !!base && messages.length >= base.digests.length &&
		base.digests.every((value, index) => value === digests[index]);
	return {
		wire: append
			? { mode: "append", baseHash: base.hash, messages: messages.slice(base.digests.length) }
			: { mode: "full", messages },
		digests,
		hash: digest(messages),
	};
}

function operationTimeout(request: CageRequest) {
	if (request.op === "turn") return request.options.timeoutMs === undefined
		? CLIENT_TIMEOUT_MS : request.options.timeoutMs + 20_000;
	return METADATA_MS;
}

async function waitForExit(closed: Promise<number | null>, timeoutMs: number) {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			closed,
			new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<number | null>) {
	child.stdin.end();
	if (await waitForExit(closed, CLEANUP_MS) !== undefined) return;
	child.kill("SIGTERM");
	if (await waitForExit(closed, 1_000) !== undefined) return;
	child.kill("SIGKILL");
	await waitForExit(closed, 1_000);
}

async function readyStream(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<Remaining> {
	const iterator = child.stdout[Symbol.asyncIterator]();
	let pending = Buffer.alloc(0);
	let consumedBytes = 0;
	for (;;) {
		signal.throwIfAborted();
		const next = await withAbort(iterator.next(), signal);
		if (next.done) throw new Error("Cage service exited before its ready line");
		pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
		for (;;) {
			const newline = pending.indexOf(10);
			if (newline < 0) break;
			const line = pending.subarray(0, newline).toString("utf8");
			pending = pending.subarray(newline + 1);
			consumedBytes += newline + 1;
			if (consumedBytes > MAX_PREAMBLE_BYTES) throw new Error("Cage service preamble is too large");
			if (line !== READY) continue;
			return {
				async *[Symbol.asyncIterator]() {
					if (pending.length) yield pending;
					for (;;) {
						const item = await iterator.next();
						if (item.done) return;
						yield item.value;
					}
				},
			};
		}
		if (consumedBytes + pending.length > MAX_PREAMBLE_BYTES) throw new Error("Cage service preamble is too large");
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

export class CageConnection {
	#profile: CageProfile;
	#state: "unopened" | "starting" | "idle" | "busy" | "installing" | "fatal" | "closed" = "unopened";
	#child?: ChildProcessWithoutNullStreams;
	#closed?: Promise<number | null>;
	#frames?: AsyncIterator<unknown>;
	#failure?: AbortController;
	#fatal?: Error;
	#nextId = 0;
	#base?: TranscriptBase;
	#launch: (profile: CageProfile) => ChildProcessWithoutNullStreams;

	constructor(profile: CageProfile, options: { launch?: (profile: CageProfile) => ChildProcessWithoutNullStreams } = {}) {
		this.#profile = profile;
		this.#launch = options.launch ?? launchService;
	}

	get state() { return this.#state; }
	get fatalError() { return this.#fatal; }

	async #start() {
		if (this.#state === "fatal") throw this.#fatal;
		if (this.#state === "closed") throw new Error("Claude Cage connection is closed");
		if (this.#state !== "unopened") return;
		this.#state = "starting";
		const failure = new AbortController();
		this.#failure = failure;
		let hasStderr = false;
		try {
			const child = this.#launch(this.#profile);
			this.#child = child;
			this.#closed = new Promise((resolve) => child.once("close", resolve));
			child.stdin.on("error", () => {});
			child.stderr.on("data", () => { hasStderr = true; });
			child.stderr.on("error", () => {});
			child.on("error", () => failure.abort(new Error("Could not launch the configured Cage executable")));
			child.once("close", (code) => {
				if (!["closed", "unopened"].includes(this.#state)) {
					failure.abort(new Error(`Cage service exited unexpectedly${code === null ? "" : ` (exit ${code})`}`));
				}
			});
			const startup = AbortSignal.any([failure.signal, AbortSignal.timeout(STARTUP_MS)]);
			const stream = await readyStream(child, startup);
			failure.signal.throwIfAborted();
			this.#frames = readFrames(stream, { maxBytes: MAX_FRAME_BYTES })[Symbol.asyncIterator]();
			this.#state = "idle";
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Cage service startup failed";
			await this.#becomeFatal(new Error(hasStderr ? `${detail} (Cage wrote to stderr)` : detail));
			throw this.#fatal;
		}
	}

	async #becomeFatal(error: Error) {
		if (this.#state === "fatal") return;
		this.#fatal = fatalError(error.message);
		this.#state = "fatal";
		this.#base = undefined;
		this.#failure?.abort(this.#fatal);
		if (this.#child && this.#closed) await stopChild(this.#child, this.#closed);
	}

	async request(request: CageRequest, options: RequestOptions = {}): Promise<unknown> {
		if (this.#state === "fatal") throw this.#fatal;
		if (this.#state === "busy" || this.#state === "starting" || this.#state === "installing") {
			throw new Error("Another Claude Cage operation is in progress");
		}
		await this.#start();
		if (this.#state !== "idle" || !this.#child || !this.#frames || !this.#failure) throw new Error("Claude Cage connection is not ready");
		this.#state = "busy";
		const id = ++this.#nextId;
		const turn = request.op === "turn";
		const planned = turn ? transcriptPlan(request.context.messages, this.#base) : undefined;
		const frame = turn
			? { ...request, id, context: undefined, transcript: planned!.wire }
			: { ...request, id };
		let submitted = false;
		let accepted = false;
		let cancelled = false;
		let cancelWrite: Promise<void> | undefined;
		let cancelTimer: NodeJS.Timeout | undefined;
		let timer: NodeJS.Timeout | undefined;
		const operationFailure = new AbortController();
		const active = AbortSignal.any([this.#failure.signal, operationFailure.signal]);
		const requestAbort = () => {
			cancelled = true;
			if (submitted && !cancelWrite) {
				cancelWrite = writeFrame(this.#child!.stdin, { type: "cancel", id }, { signal: this.#failure!.signal })
					.then(() => {
						cancelTimer = setTimeout(() => operationFailure.abort(
							connectionFailure("Cage did not confirm cancellation cleanup"),
						), CLEANUP_MS);
					})
					.catch((error) => { operationFailure.abort(connectionFailure(error)); });
			}
		};
		options.signal?.addEventListener("abort", requestAbort, { once: true });
		try {
			// A user abort never slices a JSON frame. Lifecycle failure may stop it because the connection is already fatal.
			const body = encodeFrame(frame, MAX_FRAME_BYTES);
			try {
				await writeEncodedFrame(this.#child.stdin, body, { signal: this.#failure.signal });
			} catch (error) {
				throw connectionFailure(error);
			}
			submitted = true;
			if (cancelled || options.signal?.aborted) requestAbort();
			timer = setTimeout(() => operationFailure.abort(new Error("Cage request did not complete before its deadline")),
				operationTimeout(request));
			for (;;) {
				let next;
				try {
					next = await withAbort(this.#frames.next(), active);
				} catch (error) {
					if (active.aborted) throw error;
					throw connectionFailure(error);
				}
				if (next.done) throw connectionFailure("Cage service disconnected before a terminal response");
				const response = next.value;
				if (!isRecord(response) || response.id !== id || typeof response.type !== "string") {
					throw connectionFailure("Cage response did not match the active request");
				}
				if (response.type === "accepted" && turn) {
					if (accepted || typeof response.transcriptHash !== "string" || response.transcriptHash !== planned!.hash) {
						throw connectionFailure("Cage transcript acceptance did not match the host transcript");
					}
					accepted = true;
					continue;
				}
				if (response.type === "error" && typeof response.message === "string") {
					this.#base = undefined;
					if (response.fatal === true) {
						throw connectionFailure(response.message);
					}
					if (cancelled && options.signal?.aborted) throw options.signal.reason;
					throw new Error(response.message);
				}
				if (!turn && response.type === "value" && Object.hasOwn(response, "value")) {
					if (options.signal?.aborted) throw options.signal.reason;
					return response.value;
				}
				if (!turn || response.type !== "event" || !isRecord(response.event)) {
					throw connectionFailure("Unexpected response from the Cage service");
				}
				try {
					await options.onEvent?.(response.event);
				} catch (error) {
					if (options.signal?.aborted) throw options.signal.reason;
					throw connectionFailure(error instanceof Error ? error : "Cage event reconstruction failed");
				}
				if (response.event.type === "done") {
					if (!accepted) throw connectionFailure("Cage turn completed before transcript acceptance");
					this.#base = { hash: planned!.hash, digests: planned!.digests };
					return response.event;
				}
				if (response.event.type === "error") {
					this.#base = undefined;
					return response.event;
				}
			}
		} catch (error) {
			this.#base = undefined;
			if (options.signal?.aborted && cancelled && !(active.aborted && active.reason !== options.signal.reason)) {
				throw options.signal.reason;
			}
			if (operationFailure.signal.aborted) error = connectionFailure(operationFailure.signal.reason);
			if (responseIsOperationError(error, this.#failure.signal)) throw error;
			await this.#becomeFatal(error instanceof Error ? error : new Error("Cage connection failed"));
			throw this.#fatal;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", requestAbort);
			await cancelWrite?.catch(() => {});
			clearTimeout(cancelTimer);
			if (this.#state === "busy") this.#state = "idle";
		}
	}

	async beginSetup() {
		if (this.#state === "fatal") throw this.#fatal;
		if (["busy", "starting", "installing"].includes(this.#state)) throw new Error("Wait for the current Claude Cage operation to finish");
		if (this.#state === "idle" && this.#child && this.#closed) await stopChild(this.#child, this.#closed);
		this.#child = undefined;
		this.#closed = undefined;
		this.#frames = undefined;
		this.#failure = undefined;
		this.#base = undefined;
		this.#state = "installing";
	}

	finishSetup() {
		if (this.#state === "installing") this.#state = "unopened";
	}

	async shutdown() {
		if (this.#state === "closed") return;
		const child = this.#child;
		const closed = this.#closed;
		this.#state = "closed";
		this.#base = undefined;
		this.#failure?.abort(new Error("Claude Cage session closed"));
		if (child && closed) await stopChild(child, closed);
	}
}

function responseIsOperationError(error: unknown, connectionSignal: AbortSignal) {
	if (connectionSignal.aborted) return false;
	if (!(error instanceof Error)) return false;
	if ((error as Error & { connectionFatal?: boolean }).connectionFatal) return false;
	return true;
}

export function createCageConnection(profile: CageProfile, options?: ConstructorParameters<typeof CageConnection>[1]) {
	return new CageConnection(profile, options);
}

async function runSetupProcess(
	profile: CageProfile, script: string, input: Buffer | undefined, signal: AbortSignal, timeoutMs: number,
): Promise<string> {
	try {
		checkedFile(profile.config, constants.R_OK);
		checkedFile(profile.executable, constants.X_OK);
	} catch {
		throw new Error("Check the Cage executable and profile paths in claude-cage.json");
	}
	const child = spawn(profile.executable, ["run", "--workdir", "/tmp", "--", "bash", "-c", script], {
		env: hostEnvironment(profile), cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
	let launchError: Error | undefined;
	child.once("error", (error) => { launchError = error; });
	child.stdin.on("error", () => {});
	child.stderr.resume();
	child.stdin.end(input);
	const chunks: Buffer[] = [];
	let bytes = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes <= MAX_PREAMBLE_BYTES) chunks.push(chunk);
		else child.stdout.destroy(new Error("Cage setup output is too large"));
	});
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	try {
		await finished(child.stdout, { signal: deadline, cleanup: true });
		const code = await withAbort(closed, deadline);
		if (launchError) throw launchError;
		if (code !== 0) throw new Error("Cage setup command failed");
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		if (child.exitCode === null) await stopChild(child, closed);
	}
}

export function runCageSetupStep(
	profile: CageProfile, script: string, input: Buffer | undefined, signal: AbortSignal, timeoutMs: number,
): Promise<string> {
	return runSetupProcess(profile, script, input, signal, timeoutMs);
}
