// Explicit opt-in. Run from the checkout with Node.js 22.19 or later:
//   node packages/claude-cage/tests/wired-smoke.mjs --run
// Requires an already-running Cage Wired profile. No installs, Claude CLI,
// model discovery or upstream requests are made. The archive stays in memory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const executable = process.env.CAGE_TEST_EXECUTABLE || join(process.env.HOME, ".local/opt/claude-cage-wired/0.2.0-wired.1/cage");
const commands = ["run", "--workdir", "/tmp", "--"];
const prefix = "WIRED_SMOKE ";
const scratchPattern = /^\/tmp\/pi-cage-wired-smoke\.[A-Za-z0-9]{10}$/;
const startGuest = `
set -eu
umask 077
scratch=$(mktemp -d /tmp/pi-cage-wired-smoke.XXXXXXXXXX)
cleanup() {
    status=$?
    if rm -rf -- "$scratch" && [ ! -e "$scratch" ]; then
        printf 'WIRED_SMOKE {"type":"removed","root":"%s"}\n' "$scratch"
    else
        status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'WIRED_SMOKE {"type":"allocated","root":"%s"}\n' "$scratch"
timeout 10s head -c "$1" > "$scratch/fixture.tar.gz"
tar -xzf "$scratch/fixture.tar.gz" -C "$scratch"
cd "$scratch"
# Keep the server on this command's stdio. Bound its life even if the host dies.
env -i HOME="$scratch" TMPDIR="$scratch" XDG_RUNTIME_DIR="$scratch" PATH=/usr/bin:/bin \
    timeout --kill-after=3s 75s node wired-smoke.fixture.mjs
`;

function cageOptions(config) {
	const env = { CLAUDE_CAGE_CONFIG: config };
	for (const name of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return { env, cwd: "/tmp" };
}

function openFixture(options, archive) {
	const child = spawn(executable, [...commands, "bash", "-c", startGuest, "wired-smoke", String(archive.length)], {
		...options, stdio: ["pipe", "pipe", "pipe"],
	});
	const reports = [];
	let error;
	let exit;
	child.on("error", (failure) => { error = failure; });
	child.stdin.on("error", (failure) => { error ??= failure; });
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		if (!line.startsWith(prefix)) return;
		try {
			reports.push(JSON.parse(line.slice(prefix.length)));
		} catch (failure) {
			error = failure;
		}
	});
	const completed = new Promise((resolve) => {
		child.once("close", (code, signal) => { exit = { code, signal }; resolve(exit); });
	});
	child.stdin.write(archive);

	async function waitFor(type, match = () => true, timeoutMs = 10_000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const result = reports.find((report) => report.type === type && match(report));
			if (result) return result;
			if (error) throw error;
			if (exit || Date.now() >= deadline) {
				throw new Error(`No guest fixture '${type}' report: ${JSON.stringify({ exit, reports })}`);
			}
			await delay(25);
		}
	}

	async function stop() {
		child.stdin.end("stop\n");
		const deadline = new AbortController();
		try {
			const outcome = await Promise.race([completed, delay(10_000, null, { signal: deadline.signal })]);
			assert(outcome, "Guest fixture did not exit on stdin shutdown (the guest watchdog is 75 seconds)");
			const allocated = reports.find(({ type }) => type === "allocated");
			if (allocated) {
				assert(reports.some(({ type, root }) => type === "removed" && root === allocated.root),
					`Guest temporary directory removal was not confirmed: ${allocated.root}`);
			}
			assert.deepEqual(outcome, { code: 0, signal: null }, `Guest fixture command failed: ${JSON.stringify(reports)}`);
		} finally {
			deadline.abort();
			if (!exit) {
				child.kill("SIGKILL");
				lines.close();
				child.stdout.destroy();
				child.stderr.destroy();
				child.stdin.destroy();
			}
		}
	}
	return { reports, waitFor, stop };
}

async function exercise(requestCage, profile, fixture, signal) {
	const sessionId = randomUUID();
	const cancelledSession = randomUUID();
	const user = (content) => ({ role: "user", content, timestamp: 1 });
	const model = {
		id: "wired-smoke-local", name: "Local mock", provider: "claude-cage", api: "claude-cage",
		baseUrl: "process://wired-smoke", reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const turn = (sessionId, messages, requestOptions) => requestCage(profile, {
		op: "turn", sessionId, model, context: { messages }, options: { timeoutMs: 20_000 },
	}, requestOptions);
	const messages = [user("工具回环")];
	const ids = [];
	for (let round = 1; round <= 2; round++) {
		const events = [];
		const done = await turn(sessionId, messages, { signal, onEvent: (event) => { events.push(event); } });
		assert.deepEqual(events.map(({ type }) => type), ["start", "toolcall_start", "toolcall_end", "done"]);
		assert.equal(done.reason, "toolUse");
		assert.deepEqual([done.message.model, done.message.provider, done.message.api], [model.id, model.provider, model.api]);
		const tool = events[2].toolCall;
		assert.deepEqual(done.message.content, [tool]);
		assert.equal(tool.name, "echo");
		assert.match(tool.id, /^[a-f0-9-]{36}$/);
		assert(!ids.includes(tool.id), "each tool call must have a different ID");
		ids.push(tool.id);
		assert.equal(tool.arguments.phrase, `第 ${round} 次回声`);
		messages.push(done.message, {
			role: "toolResult", toolName: tool.name, toolCallId: tool.id, isError: false,
			content: [{ type: "text", text: tool.arguments.phrase }], timestamp: round + 1,
		});
	}
	const textEvents = [];
	const finished = await turn(sessionId, messages, { signal, onEvent: (event) => { textEvents.push(event); } });
	assert.deepEqual(textEvents.map(({ type }) => type), ["start", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(textEvents[2].delta, "收到：第 2 次回声");
	assert.equal(finished.reason, "stop");
	assert.deepEqual(finished.message.content, [{ type: "text", text: "收到：第 2 次回声" }]);
	for (const id of ids) await fixture.waitFor("toolMatched", (report) => report.sessionId === sessionId && report.id === id);

	const abort = new AbortController();
	const cancelReason = new Error("Smoke cancelled the in-flight request");
	const events = [];
	await assert.rejects(turn(cancelledSession, [user("等待取消")], {
		signal: AbortSignal.any([signal, abort.signal]),
		onEvent(event) {
			events.push(event.type);
			if (event.type === "start") abort.abort(cancelReason);
		},
	}), (error) => error === cancelReason);
	assert.deepEqual(events, ["start"]);
	// Require guest-side evidence before sending any close request. A host-only
	// rejection or the mock's 20-second turn timeout cannot satisfy this check.
	const guestAbort = await fixture.waitFor("aborted", (report) => report.sessionId === cancelledSession, 3_000);
	assert.match(guestAbort.reason, /^Guest client (closed input|disconnected)$/);
	assert.deepEqual(await fixture.waitFor("closed", (report) => report.sessionId === cancelledSession), {
		type: "closed", sessionId: cancelledSession, released: true, remaining: [sessionId],
	});
	assert.equal(await requestCage(profile, { op: "close", sessionId }, { signal }), null);
	assert.deepEqual(await fixture.waitFor("closed", (report) => report.sessionId === sessionId), {
		type: "closed", sessionId, released: true, remaining: [],
	});
}

async function main() {
	const args = process.argv.slice(2);
	if (!args.length) {
		console.log("SKIP Cage Wired smoke (explicit opt-in: node packages/claude-cage/tests/wired-smoke.mjs --run)");
		return;
	}
	assert.deepEqual(args, ["--run"], "Usage: node packages/claude-cage/tests/wired-smoke.mjs --run");
	assert(process.env.HOME?.startsWith("/"), "An absolute HOME is required for the fixed Wired profile");
	const config = process.env.CAGE_TEST_CONFIG || join(process.env.HOME, ".claude-cage-wired/config.json");
	assert(statSync(config).isFile(), "The existing Wired config must be a file");
	accessSync(config, constants.R_OK);
	accessSync(executable, constants.X_OK);
	const options = cageOptions(config);
	const { requestCage } = await import("../src/transport.ts");
	const listed = execFileSync(executable, ["list"], {
		...options, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
	});
	const running = listed.split("\n").filter((line) => /^\s*(?!base\s)\S+\s+Running\s+/.test(line));
	assert.equal(running.length, 1, "Expected one already-running non-base VM in the fixed Wired profile; this test never starts it");

	const archive = execFileSync("/usr/bin/tar", ["-czf", "-", "-C", fileURLToPath(new URL("../guest/", import.meta.url)),
		"client.mjs", "protocol.mjs", "service.mjs", "-C", fileURLToPath(new URL("./", import.meta.url)),
		"wired-smoke.fixture.mjs", "wired-smoke.client.mjs"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("Wired smoke interrupted"));
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	const fixture = openFixture(options, archive);
	try {
		try {
			const { root } = await fixture.waitFor("allocated");
			assert.match(root, scratchPattern);
			assert.equal((await fixture.waitFor("ready")).root, root);
			const profile = { executable, config, clientPath: join(root, "wired-smoke.client.mjs") };
			await exercise(requestCage, profile, fixture, controller.signal);
		} finally {
			await fixture.stop();
		}
		assert.deepEqual(fixture.reports.find(({ type }) => type === "stopped"), {
			type: "stopped", retained: 0, connections: 0, clients: 5, live: [], socketRemoved: true,
		});
		console.log("PASS Cage Wired smoke: two tool IDs matched, cancellation reached the guest, close released the session, and guest resources were removed");
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
