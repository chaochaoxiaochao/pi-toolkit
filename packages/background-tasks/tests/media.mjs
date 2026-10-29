import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import register from "./fixtures/provider.ts";

for (const [kind, marker, code] of [["build", "Compiling module", 0], ["tests", "test_001", 3]]) {
	test(`media ${kind} job streams real output and exits only after its release file`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-bg-media-job-"));
		const child = spawn("python3", [fileURLToPath(new URL("./fixtures/media-job.py", import.meta.url)), kind], {
			cwd: root, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(5000),
		});
		let output = "";
		let error = "";
		try {
			const exited = new Promise((resolve, reject) => {
				child.once("error", reject);
				child.stdout.on("data", (data) => {
					output += data.toString();
					if (output.includes(marker)) writeFileSync(join(root, `release-${kind}`), "release");
				});
				child.stderr.on("data", (data) => { error += data.toString(); });
				child.once("close", (exitCode) => resolve(exitCode));
			});
			assert.equal(await exited, code, error);
			assert.ok(output.includes(marker));
			assert.match(output, kind === "build" ? /\rCompiling module.*BUILD SUCCESSFUL/s : /test_001.*one demo failure/s);
		} finally {
			child.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("offline media provider issues exactly two direct background starts, then returns while they run", async () => {
	let provider;
	register({ registerProvider(_name, value) { provider = value; }, on() {} });
	const user = { role: "user", content: "Start two background demo jobs: build progress and a test suite." };
	const model = { api: "bg-fixture", provider: "bg-fixture", id: "deterministic" };
	const events = [];
	for await (const event of provider.streamSimple(model, { messages: [user] })) events.push(event);
	const calls = events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall);
	assert.deepEqual(calls.map((call) => [call.name, call.arguments.command, call.arguments.description]), [
		["background_task", "python3 demo-job.py build", "Build progress"],
		["background_task", "python3 demo-job.py tests", "Test suite"],
	]);
	const next = [];
	for await (const event of provider.streamSimple(model, { messages: [user, { role: "toolResult", toolCallId: calls[1].id, toolName: "background_task", content: [{ type: "text", text: "Started" }] }] })) next.push(event);
	assert.equal(next.filter((event) => event.type === "toolcall_end").length, 0);
	assert.match(next.find((event) => event.type === "text_end").content, /Click a task row/);
});
