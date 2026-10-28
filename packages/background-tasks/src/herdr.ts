import { spawn } from "node:child_process";

/** One Herdr CLI call: arguments in, parsed `result` object out. */
export type HerdrCall = (args: string[]) => Promise<Record<string, any>>;

export class HerdrError extends Error {
	readonly code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
	}
}

export function isMissing(error: unknown): boolean {
	return error instanceof HerdrError && /^(tab|pane)_not_found$/.test(error.code ?? "");
}

/** Spawns the Herdr CLI without a shell. A hung call fails after `timeoutMs`. */
export function cliHerdr(binary = "herdr", timeoutMs = 10_000): HerdrCall {
	return (args) => new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, signal: AbortSignal.timeout(timeoutMs) });
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => reject(new HerdrError(`herdr ${args[0]} ${args[1]}: ${error.message}`)));
		child.once("close", (code) => {
			let parsed: { result?: Record<string, any>; error?: { code?: string; message?: string } } | undefined;
			try { parsed = JSON.parse(stdout); } catch { /* Reported below. */ }
			if (code === 0 && parsed?.result) return resolve(parsed.result);
			// Some commands, such as `pane run`, succeed without printing a response.
			if (code === 0 && !stdout.trim()) return resolve({});
			const detail = parsed?.error?.message ?? (stderr.trim() || stdout.trim() || `exit code ${code}`);
			reject(new HerdrError(`herdr ${args[0]} ${args[1]}: ${detail}`, parsed?.error?.code));
		});
	});
}
