import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readLines } from "../guest/protocol.mjs";

const { CLAUDE_CAGE_CONFIG } = process.env;
const profile = JSON.parse(readFileSync(CLAUDE_CAGE_CONFIG, "utf8"));
assert(!process.env.ANTHROPIC_API_KEY && !process.env.TEST_HOST_SECRET);
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 4), ["run", "--workdir", "/tmp", "--"]);
function log(operation) {
	appendFileSync(profile.log, `${JSON.stringify({ config: CLAUDE_CAGE_CONFIG, ...operation })}\n`);
}

process.stdout.write("Cage started its proxy\n{\"service\":\"activation\"}\n");
if (args[4] === "bash") {
	assert.equal(args[5], "-c");
	execFileSync("bash", ["-n", "-c", args[6]]);
	if (args[6].includes("PI_CAGE_CHECK=")) {
		assert.match(args[6], /systemctl --user show-environment/);
		assert.match(args[6], /claude --version/);
		log({ phase: "preflight" });
		for (const key of ["systemd", "node", "claude"]) {
			if (profile.mode !== key) process.stdout.write(`PI_CAGE_CHECK=${key}\n`);
		}
		process.stdout.write(`PI_CAGE_CLIENT=${profile.clientPath}\n`);
	} else {
		assert.match(args[6], /Installed guest client:/);
		const chunks = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		const files = execFileSync("tar", ["-tzf", "-"], { input: Buffer.concat(chunks), encoding: "utf8" }).trim().split("\n");
		log({ phase: "install", files });
		process.stdout.write(`Installed guest client: ${profile.clientPath}\n`);
	}
} else {
	assert.deepEqual(args.slice(4), ["node", profile.clientPath]);
	log({ phase: "proxy" });
	if (profile.mode === "hang-ready") {
		for await (const _ of process.stdin) assert.fail("Host wrote before ready");
	} else if (profile.mode === "preamble-limit") {
		process.stdout.write("x".repeat(129 * 1024));
	} else if (profile.mode) {
		process.stdout.write('{"type":"rea');
		await new Promise((resolve) => setTimeout(resolve, 5));
		process.stdout.write('dy","version":1}\n');
		const request = await new Promise((resolve, reject) => readLines(process.stdin, resolve, reject));
		log({ request });
		if (request.op === "close") {
			process.stdout.write(`${JSON.stringify({ id: request.id, type: "value", value: null })}\n`);
		} else if (profile.mode === "disconnect") {
			process.stderr.write("socket hang up: temporarily unavailable (503)\n");
			process.stdin.destroy();
		} else if (profile.mode === "turn-error") {
			process.stdout.write(`${JSON.stringify({ id: request.id, type: "error", message: "connection closed: 503" })}\n`);
		} else if (profile.mode === "wrong-id") {
			process.stdout.write('{"id":"unexpected","type":"value","value":null}\n');
		} else if (profile.mode === "response-limit") {
			process.stdout.write("x".repeat(32 * 1024 * 1024 + 1));
		}
		// A successful response must cause the host to close stdin, not keep a process around.
		if (!process.stdin.destroyed) {
			await new Promise((resolve) => process.stdin.on("end", resolve));
			log({ phase: "input closed" });
		}
	} else {
		process.env.XDG_RUNTIME_DIR = profile.runtime;
		await import(pathToFileURL(profile.clientPath));
	}
}
