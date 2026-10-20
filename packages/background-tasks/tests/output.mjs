import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { fixture, flush } from "./helpers.mjs";

const cases = [
	["empty", Buffer.alloc(0)],
	["small", Buffer.from("first\nsecond\n")],
	["no-newline", Buffer.from("last")],
	["line-limit", Buffer.from(Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"))],
	["byte-limit", Buffer.from(("x".repeat(200) + "\n").repeat(500))],
	["long-last-line", Buffer.from("before\n" + "z".repeat(300000))],
	["long-line-with-newline", Buffer.from("z".repeat(150000) + "\n")],
	["huge-utf8", Buffer.from("中文🙂\n".repeat(160000))],
	["utf8-long-line", Buffer.from("中文🙂".repeat(130000))],
	["invalid-utf8", Buffer.from([65, 0xf0, 0x9f])],
];
for (const [name, data] of cases) {
	test(`output matches native bash model/structured views: ${name}`, async () => {
		const f = fixture();
		try {
			const path = join(f.root, "fixture.log");
			writeFileSync(path, data);
			const native = await createBashTool(f.root).execute("reference", { command: `cat '${path}'` });
			const job = f.tasks.start({ command: "fixture" }, f.root);
			// Deliberately split multi-byte UTF-8 across chunks.
			for (let offset = 0; offset < data.length; offset += 8191) f.calls[0].onData(data.subarray(offset, offset + 8191));
			f.calls[0].resolve();
			await flush();
			const actual = f.tasks.output(job.id);
			const normalize = (text) => text.replace(/Full output: [^\]]+/g, "Full output: <log>");
			assert.equal(normalize(actual.text), normalize(native.content[0].text));
			assert.equal(actual.output, native.structuredContent.output);
			assert.equal(actual.truncated, native.structuredContent.truncated);
			assert.equal(actual.capture_complete, true);
			assert.ok(Buffer.byteLength(actual.truncation.content) <= 51200);
			assert.ok(Buffer.byteLength(actual.output) < 1024 * 1024 + 100);
		} finally { await f.close(); }
	});
}

test("running output is a consistent snapshot and does not flush incomplete UTF-8", async () => {
	const f = fixture();
	try {
		const job = f.tasks.start({ command: "stream" }, f.root);
		const bytes = Buffer.from("中文");
		f.calls[0].onData(bytes.subarray(0, 2));
		assert.equal(f.tasks.output(job.id).output, "");
		f.calls[0].onData(bytes.subarray(2));
		assert.equal(f.tasks.output(job.id).output, "中文");
		assert.equal(f.tasks.output(job.id).capture_complete, false);
	} finally { await f.close(); }
});
