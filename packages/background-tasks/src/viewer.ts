import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { errorText, summary, type TaskSnapshot } from "./background-tasks.ts";
import { isMissing, type HerdrCall } from "./herdr.ts";
import { duration } from "./widget.ts";

const UNFOCUS_POLL_MS = 1000;

// Runs inside the pane's own shell. It only reads files; the task itself runs elsewhere.
// Arguments are file paths, so the user's command text never becomes shell syntax here.
export const VIEW_SCRIPT = `printf '\\033[2J\\033[3J\\033[H'
cat "$3"
tail -n +1 -f "$1" &
tail_pid=$!
while [ ! -e "$2" ]; do sleep 0.5; done
sleep 1
kill "$tail_pid" 2>/dev/null
wait "$tail_pid" 2>/dev/null
cat "$2"
`;

interface Pane { id: string; task: string }
interface Options {
	call: HerdrCall;
	workspaceId: string;
	/** Current tasks, used to free panes and decide when the tab can close. */
	tasks: () => TaskSnapshot[];
	warn: (message: string) => void;
	/** Delay between focus checks while the user is looking at a finished tab. */
	sleep?: (ms: number) => Promise<void>;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function clean(text: string): string { return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); }
function tabLabel(task: TaskSnapshot): string { return summary(`BG · ${task.description}`, 80); }

/**
 * Shows background task logs in one Herdr tab per session. Display only: every failure
 * is reported once and never affects task execution or status.
 */
export class HerdrViewer {
	private readonly options: Options;
	private readonly commands = new Map<string, { text: string; order: number }>();
	private tab?: string;
	private panes: Pane[] = [];
	private chain: Promise<unknown> = Promise.resolve();
	private closing = false;
	private disposed = false;
	private warned = false;

	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: Options) {
		this.options = options;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
	}

	/** Opens a pane for a newly started task without taking focus. */
	show(task: TaskSnapshot, command: string): Promise<void> {
		this.commands.set(task.id, { text: command, order: this.commands.size + 1 });
		return this.enqueue(async () => { await this.open(task, false); });
	}

	/** Reopens a task's pane on user request, then focuses its tab and pane. */
	watch(task: TaskSnapshot): Promise<string> {
		return this.enqueue(async () => {
			await this.prune();
			const existing = this.panes.find((entry) => entry.task === task.id);
			const pane = existing ?? await this.open(task, false);
			if (existing) await this.options.call(["tab", "rename", this.tab!, tabLabel(task)]);
			await this.options.call(["tab", "focus", this.tab!]);
			// Panes are split left to right; Herdr focuses a pane through its neighbour.
			const index = this.panes.indexOf(pane);
			if (index > 0) await this.options.call(["pane", "focus", "--pane", this.panes[index - 1].id, "--direction", "right"]);
			else if (this.panes.length > 1) await this.options.call(["pane", "focus", "--pane", this.panes[1].id, "--direction", "left"]);
			this.closeWhenIdle();
			return pane.id;
		}, true);
	}

	/** Writes the result line into the task's pane, then closes the tab once nothing runs. */
	finished(task: TaskSnapshot): void {
		if (this.disposed) return;
		try { this.writeDone(task); }
		catch (error) { this.report(error); }
		void this.enqueue(async () => {
			const remaining = this.options.tasks().find((task) => task.status === "running");
			if (!this.tab || !remaining) return;
			try { await this.options.call(["tab", "rename", this.tab, tabLabel(remaining)]); }
			catch (error) { if (!isMissing(error)) throw error; }
		});
		this.closeWhenIdle();
	}

	/** Closes the tab immediately, for session shutdown, reload and replacement. */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.chain.catch(() => {});
		const tab = this.tab;
		this.tab = undefined;
		this.panes = [];
		if (tab) await this.options.call(["tab", "close", tab]).catch(() => {});
	}

	private enqueue<T>(step: () => Promise<T>, rethrow = false): Promise<T> {
		const run = this.chain.then(() => {
			if (this.disposed) throw new Error("Background tasks session is closed");
			return step();
		});
		this.chain = run.catch(() => {});
		return rethrow ? run : run.catch((error) => { this.report(error); return undefined as T; });
	}

	private report(error: unknown): void {
		if (this.disposed || this.warned) return;
		this.warned = true;
		this.options.warn(`Herdr task view unavailable; tasks keep running and the widget stays current. ${errorText(error)}`);
	}

	private running(): Set<string> {
		return new Set(this.options.tasks().filter((task) => task.status === "running").map((task) => task.id));
	}

	private async open(task: TaskSnapshot, retried: boolean): Promise<Pane> {
		const running = this.running();
		let pane = this.panes.find((entry) => !running.has(entry.task));
		try {
			if (!this.tab) {
				const created = await this.options.call(["tab", "create", "--workspace", this.options.workspaceId, "--cwd", task.cwd, "--label", tabLabel(task), "--no-focus"]);
				this.tab = created.tab?.tab_id;
				const root = created.root_pane?.pane_id;
				if (!this.tab || !root) throw new Error("herdr tab create omitted the tab or pane id");
				pane = { id: root, task: task.id };
				this.panes = [pane];
			} else if (pane) {
				pane.task = task.id;
				await this.options.call(["tab", "rename", this.tab, tabLabel(task)]);
			} else {
				const split = await this.options.call(["pane", "split", this.panes.at(-1)!.id, "--direction", "right", "--cwd", task.cwd, "--no-focus"]);
				if (!split.pane?.pane_id) throw new Error("herdr pane split omitted the pane id");
				pane = { id: split.pane.pane_id, task: task.id };
				this.panes.push(pane);
				await this.options.call(["tab", "rename", this.tab, tabLabel(task)]);
			}
			const label = summary(`${String(this.commands.get(task.id)!.order).padStart(2, "0")} · ${task.description}`, 80);
			await this.options.call(["pane", "rename", pane.id, label]);
			await this.options.call(["pane", "run", pane.id, this.viewCommand(task, label)]);
			return pane;
		} catch (error) {
			// The user may close a pane or the whole tab; drop stale handles and retry once.
			if (retried || !isMissing(error)) throw error;
			await this.prune();
			return this.open(task, true);
		}
	}

	/** Forgets panes the user closed. Without any of our panes, the tab is gone or closed. */
	private async prune(): Promise<void> {
		const alive: Pane[] = [];
		for (const pane of this.panes) {
			try { await this.options.call(["pane", "get", pane.id]); alive.push(pane); }
			catch (error) { if (!isMissing(error)) throw error; }
		}
		this.panes = alive;
		if (alive.length > 0 || !this.tab) return;
		const tab = this.tab;
		this.tab = undefined;
		await this.options.call(["tab", "close", tab]).catch(() => {});
	}

	private viewCommand(task: TaskSnapshot, label: string): string {
		const directory = dirname(task.log_path);
		const script = join(directory, "view.sh");
		const header = join(directory, `${task.id}.header`);
		if (!existsSync(script)) writeFileSync(script, VIEW_SCRIPT, { mode: 0o600 });
		const lines = clean(this.commands.get(task.id)!.text).split("\n");
		writeFileSync(header, `${label}\n${lines.map((line, index) => `${index ? ">" : "$"} ${line}`).join("\n")}\n# ${task.id} · cwd ${clean(task.cwd)} · timeout ${duration(task.timeout)}\n\n`, { mode: 0o600 });
		if (task.status !== "running") this.writeDone(task);
		// The leading space keeps the line out of shell history where HISTCONTROL allows it.
		return ` sh ${[script, task.log_path, this.donePath(task), header].map(quote).join(" ")}`;
	}

	private donePath(task: TaskSnapshot): string { return join(dirname(task.log_path), `${task.id}.done`); }

	private writeDone(task: TaskSnapshot): void {
		const exit = task.exit_code === undefined ? "" : ` · exit ${task.exit_code}`;
		const reason = task.reason ? `\n${clean(task.reason)}` : "";
		writeFileSync(this.donePath(task), `\n[${task.status}${exit} · ${duration(task.elapsed_seconds)}]${reason}\n`, { mode: 0o600 });
	}

	/** Closes the tab after the last task ends; waits while the user is looking at it. */
	private closeWhenIdle(): void {
		if (this.closing || this.disposed) return;
		this.closing = true;
		const check = (): Promise<void> => this.enqueue(async (): Promise<"wait" | "done"> => {
			if (!this.tab || this.running().size > 0) return "done";
			const tab = this.tab;
			try {
				const info = await this.options.call(["tab", "get", tab]);
				if (info.tab?.focused) return "wait";
				await this.options.call(["tab", "close", tab]);
			} catch (error) { if (!isMissing(error)) throw error; }
			this.tab = undefined;
			this.panes = [];
			return "done";
		}).then((state) => {
			if (state === "wait" && !this.disposed) return this.sleep(UNFOCUS_POLL_MS).then(check);
		});
		void check().finally(() => { this.closing = false; });
	}
}
