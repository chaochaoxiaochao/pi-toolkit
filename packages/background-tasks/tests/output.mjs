import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBashTool, truncateTail } from "@earendil-works/pi-coding-agent";
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

test("output exposes one bounded tail in both views while the full log remains on disk", async () => {
	const f = fixture();
	try {
		const job = f.tasks.start({ command: "fixture" }, f.root);
		const data = Array.from({ length: 110 }, (_, i) => `line-${i}`).join("\n");
		f.calls[0].onData(Buffer.from(data));
		f.calls[0].resolve();
		await flush();
		const result = f.tasks.output(job.id);
		assert.equal(result.output, Array.from({ length: 100 }, (_, i) => `line-${i + 10}`).join("\n"));
		assert.equal(result.output, result.truncation.content);
		assert.ok(result.text.startsWith(result.output));
		assert.equal(result.truncated, true);
		assert.equal(result.truncation.totalLines, 110);
		assert.equal(result.bytes, Buffer.byteLength(data));
	} finally { await f.close(); }
});

for (const [name, data] of cases) {
	test(`bounded output compared with native bash model/structured views: ${name}`, async () => {
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
			const expected = truncateTail(native.structuredContent.output, { maxLines: 100, maxBytes: 8192 });
			assert.equal(actual.output, expected.content);
			assert.equal(actual.output, actual.truncation.content);
			assert.equal(actual.truncated, native.structuredContent.truncated || expected.truncated);
			if (!actual.truncated) assert.equal(normalize(actual.text), normalize(native.content[0].text));
			else assert.match(actual.text, /Showing .*Full output:/);
			if (name === "long-line-with-newline") assert.match(actual.text, /line is 146\.5KB/);
			assert.deepEqual(readFileSync(actual.log_path), data);
			assert.equal(actual.capture_complete, true);
			assert.ok(Buffer.byteLength(actual.truncation.content) <= 8192);
			assert.ok(Buffer.byteLength(actual.output) <= 8192);
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
