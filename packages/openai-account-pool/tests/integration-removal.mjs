import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { commitAccount, loadPoolSnapshot, POOL_UNRESOLVED_API_KEY } from "../src/auth.ts";
import { setPreferredAccountId } from "../src/availability.ts";
import { poolEntryKey, poolStatePathFor, readPoolState } from "../src/store.ts";
import { fakeCredential, makeAgentDir, seedAuthFile } from "./helpers/fixtures.mjs";
import { piCodingAgentEntry } from "./helpers/pi-runtime.mjs";

const agent = makeAgentDir("pool-removal-");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent.directory;
const entry = pathToFileURL(piCodingAgentEntry());
const { ExtensionRunner, SessionManager } = await import(entry.href);
const { AuthStorage } = await import(new URL("./core/auth-storage.js", entry).href);
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry).href);
const ACCOUNT_A = "account-aaaa";
const ACCOUNT_B = "account-bbbb";
const unrelated = { type: "api_key", key: "fixture-unrelated-key" };
const statePath = poolStatePathFor(agent.directory);
const readEntries = () => JSON.parse(readFileSync(agent.authPath, "utf8"));
const notes = [];
let selection;
let confirmed = true;
let offered = [];
const ui = {
	notify: (message) => notes.push(message),
	setWidget: () => {},
	select: async (_title, options) => { offered = options; return selection?.(options); },
	confirm: async () => confirmed,
};
const native = {
	id: "openai-codex", name: "fixture", auth: { oauth: {
		name: "fixture", isSubscription: true,
		login: async () => { throw new Error("No real login allowed"); },
		refresh: async () => { throw new Error("No real refresh allowed"); },
		toAuth: async (credential) => ({ apiKey: credential.access }),
	} },
};
let runner;
async function start() {
	const loaded = await loadExtensions([fileURLToPath(new URL("../extensions/openai-account-pool.ts", import.meta.url))], agent.directory);
	assert.deepEqual(loaded.errors, []);
	let provider = native;
	const registry = {
		getProvider: () => provider,
		registerProvider: (wrapped) => { provider = wrapped; },
	};
	runner = new ExtensionRunner(loaded.extensions, loaded.runtime, agent.directory, SessionManager.inMemory(agent.directory), registry);
	runner.setUIContext(ui, "tui");
	const errors = [];
	runner.onError((error) => errors.push(error));
	await runner.emit({ type: "session_start" });
	assert.deepEqual(errors, []);
	return () => provider;
}
const remove = (query = "") => runner.getCommand("codex_pool").handler(`remove ${query}`, runner.createCommandContext());

try {
	seedAuthFile(agent.authPath, { anthropic: unrelated });
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_A, { email: "first@example.com" }) });
	// Some access tokens carry the email at the JWT root instead of in the profile claim.
	const credentialB = fakeCredential(ACCOUNT_B);
	const parts = credentialB.access.split(".");
	const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	claims.email = "second@example.com";
	parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
	credentialB.access = parts.join(".");
	await commitAccount({ authPath: agent.authPath, credential: credentialB });
	await setPreferredAccountId({ statePath, accountId: ACCOUNT_B });
	// Prime Pi's actual credential cache before the extension changes auth.json.
	const storage = AuthStorage.create(agent.authPath);
	await storage.read("openai-codex");
	await start();

	selection = (options) => options.find((option) => option.startsWith("#2 "));
	confirmed = false;
	const before = readFileSync(agent.authPath, "utf8");
	await remove();
	assert.equal(readFileSync(agent.authPath, "utf8"), before, "cancelled confirmation must not change credentials");
	assert.ok(offered.includes("#1 (first@example.com)"));
	assert.ok(offered.includes("#2 (second@example.com)"), "removal picker must recover the email from root-level token claims");

	confirmed = true;
	await remove();
	assert.match(notes.at(-1), /已删除账号 #2 \(second@example.com\)，还剩 1 个/);
	assert.equal(readEntries()[poolEntryKey(ACCOUNT_B)], undefined);
	assert.deepEqual((await loadPoolSnapshot(agent.authPath)).accounts.map((account) => account.id), [ACCOUNT_A]);
	assert.deepEqual((await storage.read("openai-codex")).piOpenAIAccountPool.accounts.map((account) => account.id), [ACCOUNT_A]);
	assert.equal((await readPoolState(statePath)).preferredAccountId, undefined);

	await runner.emit({ type: "session_shutdown" });
	const getProvider = await start();
	const restored = await storage.read("openai-codex");
	assert.equal((await getProvider().auth.oauth.toAuth(restored)).apiKey, POOL_UNRESOLVED_API_KEY);
	assert.deepEqual(restored.piOpenAIAccountPool.accounts.map((account) => account.id), [ACCOUNT_A], "restart must not resurrect the removed reference");

	await remove("first@example.com");
	assert.match(notes.at(-1), /已删除最后一个账号/);
	assert.deepEqual(readEntries(), { anthropic: unrelated }, "last removal must delete both the reference and the real credential");
	assert.equal(await storage.read("openai-codex"), undefined);
	assert.deepEqual((await readPoolState(statePath)).accounts, {});
	await runner.emit({ type: "session_shutdown" });
	await start();
	assert.equal((await loadPoolSnapshot(agent.authPath)).loggedOut, true);
	assert.deepEqual(await AuthStorage.create(agent.authPath).list(), [{ providerId: "anthropic", type: "api_key" }]);

	// A prior native logout can delete a credential without updating pool membership.
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_A, { email: "first@example.com" }) });
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_B, { email: "second@example.com" }) });
	await setPreferredAccountId({ statePath, accountId: ACCOUNT_B });
	await storage.delete(poolEntryKey(ACCOUNT_B));
	await remove("first@example.com");
	assert.deepEqual(readEntries(), { anthropic: unrelated },
		"deleting the last real credential must also remove stale siblings and the main reference");
	assert.equal((await readPoolState(statePath)).preferredAccountId, undefined);

	// Startup must prune missing membership and its preference while retaining a real login.
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_A) });
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_B) });
	await setPreferredAccountId({ statePath, accountId: ACCOUNT_B });
	await storage.delete(poolEntryKey(ACCOUNT_B));
	await runner.emit({ type: "session_shutdown" });
	await start();
	assert.deepEqual((await loadPoolSnapshot(agent.authPath)).accounts.map((account) => account.id), [ACCOUNT_A]);
	assert.equal((await readPoolState(statePath)).preferredAccountId, undefined);
	assert.ok(readEntries()[poolEntryKey(ACCOUNT_A)]);

	// An already stranded reference must be cleaned up on startup, before installing the provider.
	await storage.delete(poolEntryKey(ACCOUNT_A));
	await runner.emit({ type: "session_shutdown" });
	await start();
	assert.deepEqual(readEntries(), { anthropic: unrelated }, "startup must clear a reference with no stored credentials");
	assert.ok(notes.some((note) => /清理.*引用/.test(note)), "startup repair must be reported, not silent");

	// Also boot a real Pi process with the stranded reference, not just a mocked model registry.
	await runner.emit({ type: "session_shutdown" });
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_A) });
	await storage.delete(poolEntryKey(ACCOUNT_A));
	const manifest = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
	const boot = spawnSync(process.execPath, [
		fileURLToPath(new URL(`../${manifest.bin.pi}`, entry)),
		"-ne", "-ns", "--no-session",
		"-e", fileURLToPath(new URL("../extensions/openai-account-pool.ts", import.meta.url)),
		"--mode", "rpc",
	], {
		cwd: agent.directory, env: { ...process.env }, encoding: "utf8", timeout: 15_000,
		input: '{"type":"get_commands"}\n',
	});
	assert.ifError(boot.error);
	assert.equal(boot.status, 0, boot.stderr);
	const commands = boot.stdout.trim().split("\n").map((line) => JSON.parse(line))
		.find((event) => event.type === "response" && event.command === "get_commands");
	assert.equal(commands?.success, true, boot.stdout);
	assert.ok(commands.data.commands.some((command) => command.name === "codex_pool"), "the command must still load after restart");
	assert.deepEqual(readEntries(), { anthropic: unrelated }, "real Pi startup must clean the stranded reference");
	console.log("Removal extension integration checks passed");
} finally {
	await runner?.emit({ type: "session_shutdown" });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	agent.dispose();
}
