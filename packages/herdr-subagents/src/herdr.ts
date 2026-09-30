import { spawn } from "node:child_process";

export interface CreateTabRequest {
	workspaceId: string;
	cwd: string;
	label: string;
	env: Record<string, string>;
	focus: boolean;
	signal?: AbortSignal;
}

export interface StartAgentRequest {
	name: string;
	kind: "pi";
	paneId: string;
	args: string[];
	signal?: AbortSignal;
}

export interface PromptAgentRequest {
	target: string;
	prompt: string;
	signal?: AbortSignal;
}

export interface SplitPaneRequest {
	paneId: string;
	cwd: string;
	direction: "right" | "down";
	focus: boolean;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface HerdrAutomation {
	createTab(request: CreateTabRequest): Promise<{ tabId: string; paneId: string }>;
	startAgent(request: StartAgentRequest): Promise<void>;
	promptAgent(request: PromptAgentRequest): Promise<{ status?: string }>;
	splitPane(request: SplitPaneRequest): Promise<{ paneId: string }>;
	renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void>;
	renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void>;
	focusPane(paneId: string, signal?: AbortSignal): Promise<void>;
	isTabFocused(tabId: string, signal?: AbortSignal): Promise<boolean>;
	waitForTabUnfocused(tabId: string, signal?: AbortSignal): Promise<void>;
	paneExists(paneId: string, signal?: AbortSignal): Promise<boolean>;
	isTaskRunning(paneId: string, signal?: AbortSignal): Promise<boolean>;
	closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
}

interface HerdrResponse {
	result?: {
		tab?: { tab_id?: string; focused?: boolean };
		root_pane?: { pane_id?: string };
		pane?: { pane_id?: string };
		agent?: { status?: string };
		process_info?: { foreground_processes?: Array<{ name?: string; argv?: string[] }> };
	};
}

export class HerdrCommandError extends Error {
	readonly args: string[];
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(
		message: string,
		args: string[],
		exitCode: number | null,
		stderr: string,
	) {
		super(message);
		this.name = "HerdrCommandError";
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

export async function retryBeforePrompt<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try { return await operation(); }
		catch (error) { lastError = error; }
	}
	throw lastError;
}

async function runCommand(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let spawnError: Error | undefined;
		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
			shell: false,
		});
		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			spawnError = error;
		});
		const abort = () => child.kill("SIGTERM");
		const removeAbortListener = () => signal?.removeEventListener("abort", abort);
		child.once("close", (code) => {
			removeAbortListener();
			if (spawnError) {
				reject(new HerdrCommandError(spawnError.message, args, 1, stderr));
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
				reject(new HerdrCommandError(`Herdr command failed: ${detail}`, args, code, stderr));
				return;
			}
			resolve(stdout);
		});

		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function parseResponse(output: string, operation: string): HerdrResponse {
	try {
		return JSON.parse(output) as HerdrResponse;
	} catch {
		throw new Error(`${operation} returned invalid JSON`);
	}
}

export class CliHerdrAutomation implements HerdrAutomation {
	private readonly binary: string;

	constructor(binary = process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr") {
		this.binary = binary;
	}

	async createTab(request: CreateTabRequest): Promise<{ tabId: string; paneId: string }> {
		const args = ["tab", "create", "--workspace", request.workspaceId, "--cwd", request.cwd, "--label", request.label];
		for (const [key, value] of Object.entries(request.env).sort(([left], [right]) => left.localeCompare(right))) {
			args.push("--env", `${key}=${value}`);
		}
		args.push(request.focus ? "--focus" : "--no-focus");
		const response = parseResponse(await runCommand(this.binary, args, request.signal), "herdr tab create");
		const tabId = response.result?.tab?.tab_id;
		const paneId = response.result?.root_pane?.pane_id;
		if (!tabId || !paneId) throw new Error("herdr tab create omitted the tab or root pane id");
		return { tabId, paneId };
	}

	async startAgent(request: StartAgentRequest): Promise<void> {
		await runCommand(this.binary, ["agent", "start", request.name, "--kind", request.kind, "--pane", request.paneId, "--", ...request.args], request.signal);
	}

	async promptAgent(request: PromptAgentRequest): Promise<{ status?: string }> {
		const response = parseResponse(
			await runCommand(this.binary, ["agent", "prompt", request.target, request.prompt, "--wait"], request.signal),
			"herdr agent prompt",
		);
		return { status: response.result?.agent?.status };
	}

	async splitPane(request: SplitPaneRequest): Promise<{ paneId: string }> {
		const args = ["pane", "split", request.paneId, "--direction", request.direction, "--cwd", request.cwd, request.focus ? "--focus" : "--no-focus"];
		for (const [key, value] of Object.entries(request.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) args.push("--env", `${key}=${value}`);
		const response = parseResponse(await runCommand(this.binary, args, request.signal), "herdr pane split");
		const paneId = response.result?.pane?.pane_id;
		if (!paneId) throw new Error("herdr pane split omitted the pane id");
		return { paneId };
	}

	async renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["pane", "rename", paneId, label], signal);
	}

	async renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["tab", "rename", tabId, label], signal);
	}

	async focusPane(paneId: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["agent", "focus", paneId], signal);
	}

	async isTabFocused(tabId: string, signal?: AbortSignal): Promise<boolean> {
		const response = parseResponse(await runCommand(this.binary, ["tab", "get", tabId], signal), "herdr tab get");
		return response.result?.tab?.focused === true;
	}

	async waitForTabUnfocused(tabId: string, signal?: AbortSignal): Promise<void> {
		while (await this.isTabFocused(tabId, signal)) {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
				const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 500);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}

	async paneExists(paneId: string, signal?: AbortSignal): Promise<boolean> {
		try { await runCommand(this.binary, ["pane", "get", paneId], signal); return true; }
		catch (error) {
			if (error instanceof HerdrCommandError && /pane[_ -]?not[_ -]?found|unknown pane/i.test(`${error.message}\n${error.stderr}`)) return false;
			throw error;
		}
	}

	async isTaskRunning(paneId: string, signal?: AbortSignal): Promise<boolean> {
		try {
			const response = parseResponse(await runCommand(this.binary, ["pane", "process-info", "--pane", paneId], signal), "herdr pane process-info");
			return (response.result?.process_info?.foreground_processes ?? []).some((process) => {
				if (process.name === "pi") return true;
				return (process.argv ?? []).some((argument) => {
					const normalized = argument.replaceAll("\\", "/");
					const file = normalized.split("/").at(-1);
					return file === "pi" || (/pi-coding-agent/.test(normalized) && /(?:^|\/)cli\.js$/.test(normalized)) || /pi-coding-agent\/dist\/bundle\//.test(normalized);
				});
			});
		} catch (error) {
			if (error instanceof HerdrCommandError && /pane[_ -]?not[_ -]?found|unknown pane/i.test(`${error.message}\n${error.stderr}`)) return false;
			throw error;
		}
	}

	async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["tab", "close", tabId], signal);
	}
}
