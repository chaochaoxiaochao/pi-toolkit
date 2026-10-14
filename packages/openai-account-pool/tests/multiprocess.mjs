import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { commitAccount } from "../src/auth.ts";
import { poolEntryKey, withAuthTransaction } from "../src/store.ts";
import { fakeCredential, makeAgentDir } from "./helpers/fixtures.mjs";

const run = promisify(execFile);
const CHILD = new URL("./helpers/refresh-child.mjs", import.meta.url).pathname;
const ACCOUNT = "account-aaaa";

// ---------------------------------------------------------------------------
// Two real pi processes racing for a rotating refresh token exchange it once.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const markerDir = join(agent.directory, "markers");
		mkdirSync(markerDir);
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT, { expiresInMs: -1_000 }) });

		const [first, second] = await Promise.all([
			run(process.execPath, ["--experimental-strip-types", CHILD, agent.authPath, ACCOUNT, markerDir, "one"]),
			run(process.execPath, ["--experimental-strip-types", CHILD, agent.authPath, ACCOUNT, markerDir, "two"]),
		]);

		const results = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
		assert.deepEqual(readdirSync(markerDir).length, 1, "a rotating refresh token must be exchanged exactly once");
		assert.equal(results[0].access, results[1].access, "both processes end up with the same live credential");
		assert.equal(results.filter((result) => result.refreshed).length, 1, "only the winner reports a refresh");

		const entries = JSON.parse(readFileSync(agent.authPath, "utf8"));
		assert.equal(entries[poolEntryKey(ACCOUNT)].access, results[0].access, "the stored credential is the one both processes use");
		assert.deepEqual(entries["unrelated-one"], { type: "api_key", key: "$KEY_one" });
		assert.deepEqual(entries["unrelated-two"], { type: "api_key", key: "$KEY_two" }, "concurrent writes from another process are not lost");
		assert.equal(entries[poolEntryKey(ACCOUNT)].piOpenAIAccountPoolMembership.ordinal, 1, "membership survives rotation");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A write from this process interleaved with four child writes keeps every entry.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const markerDir = join(agent.directory, "markers");
		mkdirSync(markerDir);
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT) });

		const children = ["a", "b", "c", "d"].map((label) =>
			run(process.execPath, ["--experimental-strip-types", CHILD, agent.authPath, ACCOUNT, markerDir, label]),
		);
		const local = withAuthTransaction(agent.authPath, (entries) => ({
			value: { ...entries, anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } },
			result: undefined,
		}));
		await Promise.all([...children, local]);

		const entries = JSON.parse(readFileSync(agent.authPath, "utf8"));
		for (const label of ["a", "b", "c", "d"]) assert.deepEqual(entries[`unrelated-${label}`], { type: "api_key", key: `$KEY_${label}` });
		assert.deepEqual(entries.anthropic, { type: "api_key", key: "$ANTHROPIC_API_KEY" });
		assert.equal(readdirSync(markerDir).length, 0, "a valid credential is never refreshed");
	} finally {
		agent.dispose();
	}
}

console.log("Multiprocess tests passed");
