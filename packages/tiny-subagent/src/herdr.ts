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
	signal?: AbortSignal;
}

export interface HerdrAutomation {
	createTab(request: CreateTabRequest): Promise<{ tabId: string; paneId: string }>;
	startAgent(request: StartAgentRequest): Promise<void>;
	promptAgent(request: PromptAgentRequest): Promise<{ status?: string }>;
	splitPane(request: SplitPaneRequest): Promise<{ paneId: string }>;
	runTask(request: RunTaskRequest): Promise<void>;
	renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void>;
	renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void>;
	closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
}

interface HerdrResponse {
	result?: {
		tab?: { tab_id?: string };
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

	async runTask(request: RunTaskRequest): Promise<void> {
		const environment = Object.entries(request.env).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
		const command = `${environment ? `${environment} ` : ""}${request.args.map(shellQuote).join(" ")} -- ${shellQuote(request.prompt)}; code=$?; printf '\\n%s\\n' ${shellQuote(request.marker)}; test "$code" -eq 0`;
		await runCommand(this.binary, ["pane", "run", request.paneId, command], request.signal);
		await runCommand(this.binary, ["pane", "wait-output", request.paneId, "--match", request.marker, "--source", "recent-unwrapped"], request.signal);
	}

	async renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["pane", "rename", paneId, label], signal);
	}

	async renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["tab", "rename", tabId, label], signal);
	}

	async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
		await runCommand(this.binary, ["tab", "close", tabId], signal);
	}
}
