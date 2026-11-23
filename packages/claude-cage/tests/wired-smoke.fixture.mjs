import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGuestServer } from "./service.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const directory = join(root, "pi-claude-cage");
const socket = join(directory, "service.sock");
const report = (type, fields = {}) => console.log(`WIRED_SMOKE ${JSON.stringify({ type, ...fields })}`);
const sessions = new Map();
const usage = {
	input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Only the mock stream and cleanup methods exist: no auth, CLI or discovery.
const guest = createGuestServer({
	async *streamClaudeCode(model, { messages }, { sessionId, signal }) {
		assert.equal(model.id, "wired-smoke-local");
		assert.equal(model.baseUrl, "process://claude-code");
		const state = sessions.get(sessionId) ?? { rounds: 0, transcript: [messages[0]] };
		assert.equal(messages[0].role, "user");
		const last = messages.at(-1);
		if (state.rounds > 0) {
			assert.deepEqual(messages.slice(0, -1), state.transcript);
			assert.deepEqual(last, {
				role: "toolResult", toolName: "echo", toolCallId: state.tool.id,
				isError: false, timestamp: state.rounds + 1,
				content: [{ type: "text", text: state.tool.arguments.phrase }],
			});
			report("toolMatched", { sessionId, id: state.tool.id });
		} else {
			assert.equal(messages.length, 1);
			assert(["工具回环", "等待取消"].includes(last.content));
		}
		sessions.set(sessionId, state);
		const output = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [], usage, timestamp: Date.now(), stopReason: "stop",
		};
		yield { type: "start", partial: output };
		if (last.content === "等待取消") {
			if (!signal.aborted) await once(signal, "abort");
			report("aborted", { sessionId, reason: signal.reason.message });
			return;
		}
		if (state.rounds < 2) {
			const tool = { type: "toolCall", id: randomUUID(), name: "echo", arguments: { phrase: `第 ${state.rounds + 1} 次回声` } };
			const partial = { ...output, content: [tool] };
			const message = { ...partial, stopReason: "toolUse" };
			state.rounds++;
			state.transcript = [...messages, message];
			state.tool = tool;
			yield { type: "toolcall_start", contentIndex: 0, partial };
			yield { type: "toolcall_end", contentIndex: 0, partial, toolCall: tool };
			yield { type: "done", reason: "toolUse", message };
			return;
		}
		const text = `收到：${last.content[0].text}`;
		const partial = { ...output, content: [{ type: "text", text }] };
		yield { type: "text_start", contentIndex: 0, partial: { ...output, content: [{ type: "text", text: "" }] } };
		yield { type: "text_delta", contentIndex: 0, partial, delta: text };
		yield { type: "text_end", contentIndex: 0, partial, content: text };
		yield { type: "done", reason: "stop", message: partial };
	},
	async closeClaudeProcesses(sessionId) {
		if (sessionId === undefined) {
			sessions.clear();
			return;
		}
		const released = sessions.delete(sessionId);
		report("closed", { sessionId, released, remaining: [...sessions.keys()] });
	},
});

function processExists(pid) {
	try {
		// Signal zero checks liveness; it does not signal or stop the process.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

await mkdir(directory, { mode: 0o700 });
const listening = once(guest.server, "listening");
guest.server.listen(socket);
await listening;
let connections;
let pids;
let live;
let retained;
try {
	await chmod(socket, 0o600);
	const stop = Promise.withResolvers();
	process.stdin.once("end", stop.resolve);
	process.stdin.once("data", stop.resolve);
	for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop.resolve);
	report("ready", { root });
	await stop.promise;
	process.stdin.destroy();
	const log = await readFile(join(root, "clients"), "utf8").catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	pids = log.trim().split("\n").filter(Boolean).map(Number);
	assert(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
	retained = sessions.size;
	const getConnections = promisify(guest.server.getConnections).bind(guest.server);
	for (let attempts = 0; attempts < 40; attempts++) {
		connections = await getConnections();
		live = pids.filter(processExists);
		if (connections === 0 && live.length === 0) break;
		await delay(25);
	}
} finally {
	await guest.stop();
}
await assert.rejects(lstat(socket), { code: "ENOENT" });
report("stopped", { retained, connections, clients: pids.length, live, socketRemoved: true });
