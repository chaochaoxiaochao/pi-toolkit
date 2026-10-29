import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { CliHerdrAutomation, HerdrCommandError } from "../src/herdr.ts";
import { waitFor } from "./wait-for.mjs";
import { batchFixture, readJson, writeJson } from "./fixtures/herdr.mjs";

const f = batchFixture();
const settings = join(f.root, "response.json");
const binary = join(f.root, "herdr-fixture");
writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));
fs.writeFileSync(${JSON.stringify(join(f.root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
if (response.hold) {
 const watcher = fs.watch(${JSON.stringify(f.root)}, () => {});
 fs.writeFileSync(${JSON.stringify(join(f.root, "ready"))}, 'ready');
} else if (response.error) {
 process.stderr.write(JSON.stringify({error:response.error})); process.exitCode=1;
} else process.stdout.write(response.raw ?? JSON.stringify({result:response.result}));
`, { mode: 0o700 });
const herdr = new CliHerdrAutomation(binary);
try {
	for (const [processes, expected] of [
		[[{ name: "pi" }], true],
		[[{ name: "node", argv: ["node", "/opt/pi-coding-agent/dist/cli.js"] }], true],
		[[{ name: "node", argv: ["node", "/opt/pi-coding-agent/dist/bundle/cli.js"] }], true],
		[[{ name: "node", argv: ["node", "/tmp/cli.js"] }], false],
		[[{ name: "bash", argv: ["bash"] }], false], [[], false],
	]) {
		writeJson(settings, { result: { process_info: { foreground_processes: processes } } });
		assert.equal(await herdr.isTaskRunning("one"), expected);
		assert.deepEqual(readJson(join(f.root, "args.json")), ["pane", "process-info", "--pane", "one"]);
	}
	for (const method of ["isTaskRunning", "paneExists"]) {
		writeJson(settings, { error: { code: "temporary_failure", message: "temporary process query failure" } });
		await assert.rejects(herdr[method]("one"), (error) => error instanceof HerdrCommandError && /temporary process query failure/.test(error.message));
		writeJson(settings, { error: { code: "pane_not_found", message: "unknown pane one" } });
		assert.equal(await herdr[method]("one"), false);
	}
	writeJson(settings, { raw: "{invalid" });
	await assert.rejects(herdr.getAgentState("agent"), /invalid JSON/);
	writeJson(settings, { result: {} });
	await assert.rejects(herdr.createTab({ workspaceId: "w1", cwd: f.root, label: "test", env: {}, focus: false }), /omitted/);
	console.log("PASS real CLI argv/JSON handling distinguishes shell, Node-hosted Pi, temporary failures and missing panes");

	const controller = new AbortController();
	writeJson(settings, { result: { pane: { pane_id: "one" } } });
	for (let index = 0; index < 5; index++) {
		assert.equal(await herdr.paneExists("one", controller.signal), true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0, "completed CLI calls remove their abort listener");
	}
	writeJson(settings, { hold: true });
	const stopped = herdr.paneExists("one", controller.signal);
	const failed = assert.rejects(stopped, HerdrCommandError);
	await waitFor(() => existsSync(join(f.root, "ready")), "fixture process ready to abort");
	controller.abort();
	await failed;
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);

	// Only advance the existing focus-poll timer after its listener is installed.
	// No real 500 ms delay is needed to test listener disposal.
	const focusController = new AbortController();
	let checks = 0;
	herdr.isTabFocused = async () => ++checks === 1;
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const unfocused = herdr.waitForTabUnfocused("tab", focusController.signal);
		await Promise.resolve();
		assert.equal(getEventListeners(focusController.signal, "abort").length, 1);
		mock.timers.tick(500);
		await unfocused;
		assert.equal(getEventListeners(focusController.signal, "abort").length, 0);
		const abortedController = new AbortController();
		herdr.isTabFocused = async () => true;
		const waiting = herdr.waitForTabUnfocused("tab", abortedController.signal);
		const rejection = assert.rejects(waiting, /stop focus wait/);
		await Promise.resolve();
		assert.equal(getEventListeners(abortedController.signal, "abort").length, 1);
		abortedController.abort(new Error("stop focus wait"));
		await rejection;
		assert.equal(getEventListeners(abortedController.signal, "abort").length, 0);
	} finally { mock.timers.reset(); }
	console.log("PASS command success/abort and focus polling success/abort release every signal listener");
} finally { f.close(); }
