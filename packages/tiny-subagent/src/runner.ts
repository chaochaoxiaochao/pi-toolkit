import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

export const MAX_INLINE_BYTES = 16 * 1024;
const CHILD_ENV = "PI_SUBAGENT_CHILD";
const BINARY_ENV = "PI_TINY_SUBAGENT_PI_BINARY";

export interface TinySubagentOptions {
 model?: string;
 thinking?: string;
 tools?: string[];
 systemPrompt?: string;
 cwd?: string;
 signal?: AbortSignal;
 onUpdate?: (result: TinySubagentResult) => void;
}

export interface TinySubagentArtifacts {
 directory: string;
 stdout: string;
 stderr: string;
 finalOutput?: string;
 cleanup: "remove directory when no longer needed";
}

export interface TinySubagentContent {
 type?: string;
 text?: string;
 name?: string;
 arguments?: Record<string, unknown>;
}

export interface TinySubagentMessage {
 role?: string;
 content?: string | TinySubagentContent[];
 toolCallId?: string;
 toolName?: string;
 isError?: boolean;
 stopReason?: string;
 errorMessage?: string;
 model?: string;
}

export interface TinySubagentResult {
 ok: boolean;
 output: string;
 outputBytes: number;
 stderr: string;
 stderrBytes: number;
 stdout: string;
 stdoutBytes: number;
 protocolErrors: string[];
 errorMessage?: string;
 stopReason?: string;
 exitCode: number | null;
 signal: NodeJS.Signals | null;
 model?: string;
 cwd: string;
 durationMs: number;
 messages: TinySubagentMessage[];
 artifacts?: TinySubagentArtifacts;
}

interface JsonEvent {
 type?: string;
 message?: TinySubagentMessage;
}

class Capture {
	private readonly stream;
	private inline = "";
	private truncated = false;
	bytes = 0;

	readonly path: string;
	constructor(path: string) {
		this.path = path;
		this.stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
	}


	write(text: string): void {
		this.bytes += Buffer.byteLength(text, "utf8");
		this.stream.write(text);
		if (this.truncated) return;
		const next = this.inline + text;
		if (Buffer.byteLength(next, "utf8") <= MAX_INLINE_BYTES) {
			this.inline = next;
			return;
		}
		this.inline = truncateUtf8(next, MAX_INLINE_BYTES);
		this.truncated = true;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.stream.once("error", reject);
			this.stream.once("finish", resolve);
			this.stream.end();
		});
	}

	preview(): string {
		return this.truncated ? `${this.inline}\n[truncated after ${MAX_INLINE_BYTES} bytes; see artifact file]` : this.inline;
	}
}

function truncateUtf8(text: string, maxBytes: number): string {
	let result = text.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function getFinalText(messages: TinySubagentMessage[]): string {
 for (let i = messages.length - 1; i >= 0; i--) {
  const message = messages[i];
  if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
  return message.content
   .filter((part) => part.type === "text" && typeof part.text === "string")
   .map((part) => part.text as string)
   .join("");
 }
 return "";
}

function parseLine(line: string, messages: TinySubagentMessage[], protocolErrors: string[]): boolean {
 if (!line.trim()) return false;
 try {
  const event = JSON.parse(line) as JsonEvent;
  if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
   messages.push(event.message);
   return true;
  }
 } catch {
  if (protocolErrors.length < 20) protocolErrors.push(truncateUtf8(line, 4096));
 }
 return false;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const configuredBinary = process.env[BINARY_ENV]?.trim();
	if (configuredBinary) return { command: configuredBinary, args };

	const entry = process.argv[1];
	if (entry && existsSync(entry) && /\.(?:mjs|cjs|js)$/i.test(entry)) {
		try {
			const resolved = realpathSync(entry);
			if (resolved === entry || existsSync(resolved)) return { command: process.execPath, args: [entry, ...args] };
		} catch {
			// Fall through to the Pi binary on PATH.
		}
	}

	if (/^pi(?:\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
	return { command: "pi", args };
}

function stopReasonIsFailure(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

export async function runTinySubagent(prompt: string, options: TinySubagentOptions = {}): Promise<TinySubagentResult> {
	const cwd = options.cwd ?? process.cwd();
	const artifactDirectory = await mkdtemp(join(tmpdir(), "pi-tiny-subagent-"));
	const stdoutCapture = new Capture(join(artifactDirectory, "stdout.jsonl"));
	const stderrCapture = new Capture(join(artifactDirectory, "stderr.log"));
	const args = ["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills"];
	if (options.model?.trim()) args.push("--model", options.model.trim());
	if (options.thinking?.trim()) args.push("--thinking", options.thinking.trim());
	if (options.tools?.length) args.push("--tools", options.tools.join(","));
	if (options.systemPrompt?.trim()) {
		const systemPromptPath = join(artifactDirectory, "system-prompt.md");
		await writeFile(systemPromptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
		args.push("--append-system-prompt", systemPromptPath);
	}
	args.push("--", prompt);

	const startedAt = Date.now();
	const messages: TinySubagentMessage[] = [];
	const protocolErrors: string[] = [];
	let stdoutBuffer = "";
	let errorMessage: string | undefined;
	let aborted = false;
	let exitCode: number | null = null;
	let childSignal: NodeJS.Signals | null = null;
	let spawnError: Error | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	const invocation = getPiInvocation(args);


	const emitUpdate = () => {
		if (!options.onUpdate) return;
		const output = getFinalText(messages);
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		options.onUpdate({
			ok: false,
			output,
			outputBytes: Buffer.byteLength(output, "utf8"),
			stderr: stderrCapture.preview(),
			stderrBytes: stderrCapture.bytes,
			stdout: stdoutCapture.preview(),
			stdoutBytes: stdoutCapture.bytes,
			protocolErrors: [...protocolErrors],
			...(lastAssistant?.stopReason ? { stopReason: lastAssistant.stopReason } : {}),
			exitCode,
			signal: childSignal,
			...(options.model ?? lastAssistant?.model ? { model: options.model ?? lastAssistant?.model } : {}),
			cwd,
			durationMs: Date.now() - startedAt,
			messages: messages.slice(),
		});
	};

	emitUpdate();
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		try {
			child = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [CHILD_ENV]: "1" },
			});
		} catch (error) {
			spawnError = error instanceof Error ? error : new Error(String(error));
			finish();
			return;
		}
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stdoutCapture.write(text);
			stdoutBuffer += text;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (parseLine(line, messages, protocolErrors)) emitUpdate();
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => stderrCapture.write(chunk.toString()));
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (code, signal) => {
			if (stdoutBuffer && parseLine(stdoutBuffer, messages, protocolErrors)) emitUpdate();
			// Node may report a negative pseudo-exit code for ENOENT; expose a stable process failure code and keep the real error in errorMessage.
			exitCode = spawnError ? 1 : code;
			childSignal = signal;
			finish();
		});

		const terminate = () => {
			if (aborted) return;
			aborted = true;
			child?.kill("SIGTERM");
			setTimeout(() => {
				if (child && !child.killed) child.kill("SIGKILL");
			}, 5000).unref();
		};
		if (options.signal) {
			if (options.signal.aborted) terminate();
			else options.signal.addEventListener("abort", terminate, { once: true });
		}
	});

	await Promise.all([stdoutCapture.close(), stderrCapture.close()]);
	const finalOutput = getFinalText(messages);
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	const stopReason = lastAssistant?.stopReason;
	errorMessage = spawnError?.message ?? lastAssistant?.errorMessage;
	if (aborted) errorMessage ||= "Tiny subagent was aborted";
	if (!finalOutput && exitCode === 0 && !stopReason) errorMessage ||= "No assistant output received";
	if (protocolErrors.length > 0 && !finalOutput && !errorMessage) errorMessage = "Pi emitted invalid JSON output";
	if (stopReasonIsFailure(stopReason)) errorMessage ||= `Subagent stopped with reason: ${stopReason}`;

	const outputBytes = Buffer.byteLength(finalOutput, "utf8");
	const keepArtifacts = stdoutCapture.bytes > MAX_INLINE_BYTES || stderrCapture.bytes > MAX_INLINE_BYTES || outputBytes > MAX_INLINE_BYTES;
	let artifacts: TinySubagentArtifacts | undefined;
	if (keepArtifacts) {
		const finalOutputPath = join(artifactDirectory, "final-output.txt");
		if (outputBytes > 0) await writeFile(finalOutputPath, finalOutput, { encoding: "utf8", mode: 0o600 });
		artifacts = {
			directory: artifactDirectory,
			stdout: stdoutCapture.path,
			stderr: stderrCapture.path,
			cleanup: "remove directory when no longer needed",
			...(outputBytes > MAX_INLINE_BYTES ? { finalOutput: finalOutputPath } : {}),
		};
	} else {
		await rm(artifactDirectory, { recursive: true, force: true });
	}

	return {
		ok: !errorMessage && exitCode === 0 && childSignal === null && !stopReasonIsFailure(stopReason),
		output: outputBytes > MAX_INLINE_BYTES ? `${truncateUtf8(finalOutput, MAX_INLINE_BYTES)}\n[truncated after ${MAX_INLINE_BYTES} bytes; see artifact file]` : finalOutput,
		outputBytes,
		stderr: stderrCapture.preview(),
		stderrBytes: stderrCapture.bytes,
		stdout: stdoutCapture.preview(),
		stdoutBytes: stdoutCapture.bytes,
		protocolErrors,
		...(errorMessage ? { errorMessage } : {}),
		...(stopReason ? { stopReason } : {}),
		exitCode,
		signal: childSignal,
		...(options.model ?? lastAssistant?.model ? { model: options.model ?? lastAssistant?.model } : {}),
		cwd,
		durationMs: Date.now() - startedAt,
		messages: messages.slice(),
		...(artifacts ? { artifacts } : {}),
	};
}
