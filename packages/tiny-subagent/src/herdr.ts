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
	signal?: AbortSignal;
}

export interface RunTaskRequest {
	paneId: string;
	args: string[];
	prompt: string;
	env: Record<string, string>;
	marker: string;
	stalledWarningMs?: number;
	onStalled?: () => void;
	signal?: AbortSignal;
}

export interface HerdrAutomation {
	createTab(request: CreateTabRequest): Promise<{ tabId: string; paneId: string }>;
	startAgent(request: StartAgentRequest): Promise<void>;
	promptAgent(request: PromptAgentRequest): Promise<{ status?: string }>;
	splitPane(request: SplitPaneRequest): Promise<{ paneId: string }>;
	prepareTask(args: string[], signal?: AbortSignal): Promise<void>;
	runTask(request: RunTaskRequest): Promise<void>;
	renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void>;
	renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void>;
	focusPane(paneId: string, signal?: AbortSignal): Promise<void>;
	isTabFocused(tabId: string, signal?: AbortSignal): Promise<boolean>;
	waitForTabUnfocused(tabId: string, signal?: AbortSignal): Promise<void>;
	paneExists(paneId: string, signal?: AbortSignal): Promise<boolean>;
	closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
}

interface HerdrResponse {
	result?: {
		tab?: { tab_id?: string; focused?: boolean };
		root_pane?: { pane_id?: string };
		pane?: { pane_id?: string };
		agent?: { status?: string };
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
		child.once("close", (code) => {
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

		const abort = () => child.kill("SIGTERM");
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class CliHerdrAutomation implements HerdrAutomation {
	private readonly binary: string;

	constructor(binary = process.env.PI_TINY_SUBAGENT_HERDR_BINARY?.trim() || "herdr") {
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
		const response = parseResponse(await runCommand(this.binary, args, request.signal), "herdr pane split");
		const paneId = response.result?.pane?.pane_id;
		if (!paneId) throw new Error("herdr pane split omitted the pane id");
		return { paneId };
	}

	async prepareTask(args: string[], signal?: AbortSignal): Promise<void> {
		const [binary] = args;
		if (!binary) throw new Error("Child Pi command is empty");
		await runCommand(binary, ["--version"], signal);
	}

	async runTask(request: RunTaskRequest): Promise<void> {
		const environment = Object.entries(request.env).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
		const encodedMarker = Buffer.from(request.marker, "utf8").toString("base64");
		const command = `${environment ? `${environment} ` : ""}${request.args.map(shellQuote).join(" ")} -- ${shellQuote(request.prompt)}; code=$?; printf '\\n%s\\n' "$(printf %s ${shellQuote(encodedMarker)} | base64 -d)"; test "$code" -eq 0`;
		await runCommand(this.binary, ["pane", "run", request.paneId, command], request.signal);
		let lastOutput = "";
		let lastActivity = Date.now();
		let warned = false;
		let checking = false;
		const interval = request.stalledWarningMs ? setInterval(async () => {
			if (checking) return;
			checking = true;
			try {
				const output = await runCommand(this.binary, ["pane", "read", request.paneId, "--source", "recent-unwrapped", "--lines", "40"], request.signal);
				if (output !== lastOutput) { lastOutput = output; lastActivity = Date.now(); warned = false; }
				else if (!warned && Date.now() - lastActivity >= (request.stalledWarningMs ?? 0)) { warned = true; request.onStalled?.(); }
			} catch {}
			finally { checking = false; }
		}, Math.max(250, Math.min(1000, Math.floor(request.stalledWarningMs / 2)))) : undefined;
		try { await runCommand(this.binary, ["pane", "wait-output", request.paneId, "--match", request.marker, "--source", "recent-unwrapped"], request.signal); }
		finally { if (interval) clearInterval(interval); }
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
				const timer = setTimeout(resolve, 500);
				if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
			});
		}
	}

	async paneExists(paneId: string, signal?: AbortSignal): Promise<boolean> {
		try { await runCommand(this.binary, ["pane", "get", paneId], signal); return true; }
		catch { return false; }
	}

	async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["tab", "close", tabId], signal);
	}
}
