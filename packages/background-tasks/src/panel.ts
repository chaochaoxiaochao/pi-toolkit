import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { errorText, summary, type BackgroundTasks, type Clock, type TaskSnapshot } from "./background-tasks.ts";
import { duration } from "./widget.ts";

function clean(text: string): string {
	return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f\uFFF9-\uFFFB]/g, "");
}
function color(task: TaskSnapshot): "accent" | "success" | "muted" | "error" {
	return task.status === "running" ? "accent" : task.status === "succeeded" ? "success" : task.status === "cancelled" ? "muted" : "error";
}

/** An editor-local interaction. Selection is by ID, so completion cannot retarget x. */
export class BackgroundPanel {
	private readonly tasks: BackgroundTasks;
	private readonly clock: Clock;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private selected?: string;
	private detail = false;
	private timer?: unknown;
	private closed = false;
	private stopping = new Set<string>();
	private error?: string;
	private rows = new Map<number, string>();
	readonly capturesViewportInput = true;

	constructor(tasks: BackgroundTasks, clock: Clock, theme: Theme, keys: KeybindingsManager, requestRender: () => void, done: () => void) {
		this.tasks = tasks;
		this.clock = clock;
		this.theme = theme;
		this.keys = keys;
		this.requestRender = requestRender;
		this.done = done;
		const list = tasks.list();
		this.selected = list.tasks[0]?.id;
		this.detail = list.running === 1 || list.tasks.length === 1;
		this.tick();
	}

	private tick(): void {
		this.timer = this.clock.setTimeout(() => {
			if (this.closed) return;
			this.requestRender();
			this.tick();
		}, 1000);
	}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private close(): void { this.dispose(); this.done(); }
	invalidate(): void { this.rows.clear(); }

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "alt+j")) return this.close();
		if (this.detail && (this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "space"))) return this.close();
		if (this.detail && matchesKey(data, "left")) {
			this.detail = false;
		} else if (matchesKey(data, "x")) {
			void this.stop();
			return;
		} else if (!this.detail) {
			const list = this.tasks.list().tasks;
			const index = Math.max(0, list.findIndex((task) => task.id === this.selected));
			if (this.keys.matches(data, "tui.select.up")) this.selected = list[Math.max(0, index - 1)]?.id;
			else if (this.keys.matches(data, "tui.select.down")) this.selected = list[Math.min(list.length - 1, index + 1)]?.id;
			else if (this.keys.matches(data, "tui.select.confirm") && this.selected) this.detail = true;
			else return;
		} else return;
		this.error = undefined;
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || this.detail || event.type !== "click" || event.button !== "left") return;
		const id = this.rows.get(event.y);
		if (!id) return;
		this.selected = id;
		this.detail = true;
		this.error = undefined;
		return { handled: true, render: true };
	}

	private async stop(): Promise<void> {
		const id = this.selected;
		if (!id || this.stopping.has(id) || this.tasks.get(id).status !== "running") return;
		this.stopping.add(id);
		this.requestRender();
		try { await this.tasks.cancel(id); }
		catch (error) { this.error = errorText(error); }
		finally {
			this.stopping.delete(id);
			if (!this.closed) this.requestRender();
		}
	}

	render(width: number): string[] {
		this.rows.clear();
		const inner = Math.max(1, width - 4);
		const body = this.detail && this.selected ? this.details(inner, this.tasks.get(this.selected)) : this.list(inner);
		if (this.error) body.push(this.theme.fg("error", this.error));
		return [this.theme.fg("accent", "─".repeat(Math.max(0, width))), ...body.map((line) => line ? truncateToWidth(`  ${line}`, width) : ""), ""];
	}

	private list(width: number): string[] {
		const { theme } = this;
		const list = this.tasks.list();
		if (!list.tasks.some((task) => task.id === this.selected)) this.selected = list.tasks[0]?.id;
		const lines = [theme.fg("accent", theme.bold("Background")), theme.fg("muted", `${list.running} active ${list.running === 1 ? "shell" : "shells"}`), ""];
		// Bound history height, keeping the selected task visible without losing its ID.
		const index = Math.max(0, list.tasks.findIndex((task) => task.id === this.selected));
		const start = Math.max(0, index - 7);
		const visible = list.tasks.slice(start, start + 8);
		const labelWidth = Math.max(1, ...visible.map((task) => visibleWidth(summary(this.tasks.command(task.id)))));
		let history = false;
		for (const task of visible) {
			if (task.status !== "running" && !history) {
				lines.push("", `    Earlier in this session (${list.total - list.running})`);
				history = true;
			}
			this.rows.set(lines.length + 1, task.id); // Top rule occupies row zero.
			const label = summary(this.tasks.command(task.id));
			const status = this.stopping.has(task.id) ? "stopping" : task.status;
			const commandWidth = Math.max(1, Math.min(labelWidth, 64, width - status.length - 6));
			lines.push(`${task.id === this.selected ? theme.fg("accent", "❯") : " "} ${theme.fg(color(task), "●")}${truncateToWidth(label, commandWidth, "…", true)}  ${theme.fg(color(task), status)}`);
		}
		if (!history) lines.push("", `    Earlier in this session (${list.total - list.running})`);
		if (!list.total) lines.push(theme.fg("muted", "No shells in this session"));
		if (list.tasks.length > visible.length || list.omitted) lines.push(theme.fg("dim", `Showing ${start + 1}–${start + visible.length} of ${list.tasks.length}${list.omitted ? ` · ${list.omitted} older tasks omitted` : ""}`));
		const selected = list.tasks.find((task) => task.id === this.selected);
		lines.push("", theme.fg("dim", `↑/↓ to select · Enter to view${selected?.status === "running" ? " · x to stop" : ""} · Esc to close`));
		return lines;
	}

	private details(width: number, task: TaskSnapshot): string[] {
		const { theme } = this;
		const field = (name: string, value: string) => `${theme.bold(name.padEnd(10))}${value}`;
		const preview = clean(this.tasks.command(task.id)).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
		const commandLines = wrapTextWithAnsi(preview.slice(0, 8192), Math.max(1, width - 10));
		const command = commandLines.slice(0, 3);
		if (commandLines.length > 3 || preview.length > 8192) command[command.length - 1] = truncateToWidth(command.at(-1)! + "…", Math.max(1, width - 10), "…");
		const lines = [theme.fg("accent", theme.bold("Shell details")), "",
			field("Status:", theme.fg(color(task), this.stopping.has(task.id) ? "stopping" : task.status)),
			field("Runtime:", duration(task.elapsed_seconds)),
			field("Command:", command[0] ?? ""), ...command.slice(1).map((line) => "          " + line)];
		if (task.exit_code !== undefined) lines.push(field("Exit:", String(task.exit_code)));
		if (task.reason) lines.push(field("Reason:", clean(task.reason)));
		lines.push("", theme.bold("Output:"));
		try {
			const view = this.tasks.output(task.id);
			const output = clean(view.output).replace(/\n$/, "");
			const tail = output ? output.split("\n") : [];
			lines.push(...(tail.length ? tail.slice(-10).map((line) => truncateToWidth(line, width)) : [theme.fg("muted", "No output available")]));
			if (view.truncated || tail.length > 10) lines.push(theme.fg("dim", `Tail only · ${task.log_path}`));
			if (task.status !== "running" && !view.capture_complete) lines.push(theme.fg("error", "Output capture is incomplete."));
		} catch (error) { lines.push(theme.fg("error", errorText(error))); }
		lines.push("", theme.fg("dim", `← to go back · Esc/Enter/Space to close${task.status === "running" ? " · x to stop" : ""}`));
		return lines;
	}
}
