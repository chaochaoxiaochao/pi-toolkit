import assert from "node:assert/strict";
import { unlinkSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundPanel } from "../src/panel.ts";
import { BackgroundFooter } from "../src/widget.ts";
import { fixture, flush } from "./helpers.mjs";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const click = (x, y, button = "left") => ({ type: "click", button, x, y });
function panel(f) {
	let renders = 0, closed = 0;
	const view = new BackgroundPanel(f.tasks, f.clock, theme, keys, () => renders++, () => closed++);
	return { view, text: (width = 120) => view.render(width).join("\n"), get renders() { return renders; }, get closed() { return closed; } };
}

test("compact count, singular/plural, five-second retention and bounded mouse hit region", async () => {
	const f = fixture();
	try {
		f.tasks.start({ command: "first" }, f.root);
		let opened = 0;
		let status = "", panelOpen = false;
		const native = { render: () => ["path", "usage model", ...(status ? [status] : [])], invalidate() {} };
		const widget = new BackgroundFooter(native, () => f.tasks.list().tasks, f.clock, theme, () => !!status, () => panelOpen, () => opened++);
		assert.deepEqual(widget.render(120), ["path", "usage model", "1 shell · Alt+J"]);
		assert.equal(widget.handleMouse(click(7, 2)), undefined);
		assert.equal(widget.handleMouse(click(2, 1)), undefined);
		assert.equal(widget.handleMouse(click(2, 2, "right")), undefined);
		assert.equal(widget.handleMouse(click(2, 2)).handled, true);
		assert.equal(opened, 1);
		f.tasks.start({ command: "second" }, f.root);
		assert.match(widget.render(120).at(-1), /^2 shells/);
		f.calls[1].resolve(3); await flush();
		assert.match(widget.render(120).at(-1), /^1 shell · 1 done/);
		f.clock.advance(5000);
		assert.equal(widget.render(120).at(-1), "1 shell · Alt+J");
		status = "editor: apply_patch";
		assert.equal(widget.render(120).at(-1), `${status} · 1 shell · Alt+J`);
		assert.equal(widget.handleMouse(click(2, 2)), undefined, "editor status is not a shell click");
		assert.equal(widget.handleMouse(click(23, 2)).handled, true);
		panelOpen = true;
		assert.deepEqual(widget.render(120), []);
		assert.equal(widget.handleMouse(click(23, 2)), undefined);
		panelOpen = false;
		status = "中文状态".repeat(20);
		for (const width of [0, 1, 8, 40]) {
			const row = widget.render(width).at(-1);
			assert.ok(visibleWidth(row) <= width);
			if (width >= 8) assert.match(row, /1 shell/, "keep the count visible even if other statuses are long");
		}
		widget.invalidate();
		assert.equal(widget.handleMouse(click(2, 2)), undefined, "resize/theme invalidation clears stale hit regions");
		f.calls[0].resolve(); await flush();
		f.clock.advance(5000);
		assert.deepEqual(widget.render(120), native.render(120), "expired count leaves the native footer untouched");
	} finally { await f.close(); }
});

test("single shell opens aligned, compact details without changing the original script", async () => {
	const f = fixture(); let p;
	try {
		const command = 'printf "hello"\nprintf "中文"';
		const task = f.tasks.start({ command, description: "Short label" }, f.root);
		assert.equal(f.tasks.command(task.id), command);
		assert.equal(task.command, undefined);
		p = panel(f);
		assert.match(p.text(), /Shell details\n\n  Status:   running\n  Runtime:  0s\n  Command:  printf "hello" printf "中文"\n\n  Output:\n  No output available/);
		assert.equal(f.calls[0].command, command);
		f.clock.advance(209000);
		assert.match(p.text(), /Runtime:  3m 29s/);
		assert.ok(p.renders > 0);
		p.view.handleInput("\x1b[D");
		assert.match(p.text(), /Background\n  1 active shell/);
		p.view.handleInput("\r");
		assert.match(p.text(), /Shell details/);
		p.view.handleInput(" ");
		assert.equal(p.closed, 1);
		assert.equal(f.calls[0].signal.aborted, false, "closing only dismisses the view");
		assert.equal(f.clock.timers.size, 1, "only the job deadline remains");
	} finally { p?.view.dispose(); await f.close(); }
});

test("command preview folds line breaks and indentation before width wrapping", async () => {
	const f = fixture(); let p;
	try {
		const command = '\nset -e\r\n  export JAVA_HOME=/opt/jdk-11.0.32\r\t export PATH="$JAVA_HOME/bin:$PATH"\n\n  ./gradlew test\n';
		const task = f.tasks.start({ command }, f.root);
		p = panel(f);
		assert.match(p.text(), /Command:  set -e export JAVA_HOME=\/opt\/jdk-11\.0\.32 export PATH="\$JAVA_HOME\/bin:\$PATH" \.\/gradlew test\n\n  Output:/);
		assert.doesNotMatch(p.text(), /…/);
		const narrow = p.text(64);
		assert.match(narrow, /\.\/gradlew test/);
		assert.doesNotMatch(narrow, /…/);
		assert.ok(p.view.render(64).every((line) => visibleWidth(line) <= 64));
		assert.equal(f.tasks.command(task.id), command);
		assert.equal(f.calls[0].command, command);
	} finally { p?.view.dispose(); await f.close(); }
});

test("compact preview preserves inline spaces and applies its length guard after folding", async () => {
	const f = fixture(); let p;
	try {
		const command = 'printf "hello  中文"\n' + " \n\t".repeat(3000) + 'printf "done"';
		const task = f.tasks.start({ command }, f.root);
		p = panel(f);
		assert.match(p.text(), /Command:  printf "hello  中文" printf "done"\n\n  Output:/);
		assert.doesNotMatch(p.text(), /…/);
		assert.equal(f.tasks.command(task.id), command);
		assert.equal(f.calls[0].command, command);
	} finally { p?.view.dispose(); await f.close(); }
});

test("multiple shells: arrow selection, click, identity across completion, x stops only selected job", async () => {
	const f = fixture(); let p;
	try {
		const a = f.tasks.start({ command: "first" }, f.root);
		const b = f.tasks.start({ command: "second" }, f.root);
		p = panel(f);
		assert.match(p.text(), /Background\n  2 active shells/);
		assert.match(p.text(), /❯ ●first/);
		p.view.handleInput("\x1b[B");
		assert.match(p.text(), /❯ ●second/);
		f.calls[0].resolve(); await flush();
		assert.match(p.text(), /❯ ●second/);
		p.view.handleInput("\r");
		assert.match(p.text(), /Command:  second/);
		p.view.handleInput("x"); p.view.handleInput("x");
		assert.equal(f.calls[1].signal.aborted, true);
		assert.equal(f.calls[0].signal.aborted, false);
		assert.match(p.text(), /Status:   stopping/);
		f.calls[1].reject(new Error("cancelled")); await flush();
		assert.equal(f.tasks.get(b.id).status, "cancelled");
		assert.doesNotMatch(p.text(), /x to stop/);
		p.view.handleInput("\x1b[D");
		const lines = p.view.render(120);
		assert.match(lines.join("\n"), /Earlier in this session \(2\)/);
		const row = lines.findIndex((line) => line.includes("●first"));
		assert.equal(p.view.handleMouse(click(4, 1)), undefined);
		assert.equal(p.view.handleMouse(click(4, row)).handled, true);
		assert.match(p.text(), /Command:  first/);
		assert.equal(f.tasks.get(a.id).status, "succeeded");
	} finally { p?.view.dispose(); await f.close(); }
});

test("bounded, sanitized output, long command wrapping, error states and narrow/CJK widths", async () => {
	const f = fixture(); let p;
	try {
		const task = f.tasks.start({ command: "echo 中文".repeat(1000) }, f.root);
		p = panel(f);
		f.calls[0].onData(Buffer.from("\x1b]52;c;c2VjcmV0\x07\x1b[31mRED\x1b[0m\uFFF9\n" + Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")));
		const text = p.text();
		assert.match(text, /…/);
		assert.match(text, /line 119/);
		assert.doesNotMatch(text, /line 109|\x1b|\uFFF9/);
		assert.match(text, /Tail only/);
		for (const width of [0, 1, 8, 20, 40, 80, 120]) assert.ok(p.view.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
		f.calls[0].resolve(4); await flush();
		assert.match(p.text(), /Status:   failed/);
		assert.match(p.text(), /Exit:     4/);
		assert.match(p.text(), /Reason:   Command exited with code 4/);
		unlinkSync(task.log_path);
		assert.match(p.text(), /Cannot read task log/);
	} finally { p?.view.dispose(); await f.close(); }
});

test("empty state, history paging, stable selected completed ID, timer disposal", async () => {
	const f = fixture(); let p;
	try {
		p = panel(f);
		assert.match(p.text(), /No shells in this session/);
		p.view.handleInput("x"); p.view.handleInput("\r");
		for (let i = 0; i < 25; i++) {
			f.tasks.start({ command: `job ${i}` }, f.root);
			f.calls.at(-1).resolve(); await flush();
		}
		assert.match(p.text(), /Earlier in this session \(25\)/);
		for (let i = 0; i < 19; i++) p.view.handleInput("\x1b[B");
		assert.match(p.text(), /❯ ●job 5/);
		assert.match(p.text(), /5 older tasks omitted/);
		p.view.handleInput("\r");
		assert.match(p.text(), /Command:  job 5/);
		p.view.handleInput("\r");
		assert.equal(p.closed, 1);
		assert.equal(f.clock.timers.size, 0);
		const renders = p.renders;
		f.clock.advance(3000);
		assert.equal(p.renders, renders);
	} finally { p?.view.dispose(); await f.close(); }
});

test("production extension registers no slash command and has no Herdr execution dependency", () => {
	const source = readFileSync(new URL("../extensions/background-tasks.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /registerCommand|Herdr|herdr|\/bg/);
});
