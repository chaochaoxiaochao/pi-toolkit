import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	accountCredential,
	accountIdOf,
	commitAccount,
	disablePool,
	ensureFreshAccountCredential,
	isPoolReferenceEntry,
	loadPoolSnapshot,
	POOL_REFERENCE_TOKEN,
	POOL_UNRESOLVED_API_KEY,
	removeAccount,
} from "../src/auth.ts";
import { poolEntryKey } from "../src/store.ts";
import { fakeCredential, makeAgentDir, seedAuthFile } from "./helpers/fixtures.mjs";
import { NativeCredentialStore } from "./helpers/native-credential-store.mjs";
import { piAiEntry } from "./helpers/pi-runtime.mjs";

/**
 * Blocking integration check for the account pool.
 *
 * It runs against the real pi-ai `Models` orchestration to answer two questions before any
 * further implementation: does a second plain login to the same provider really overwrite the
 * first one, and can the pool keep several accounts while pi resolves request auth from a
 * non-secret reference and the provider substitutes the selected account?
 */

const { createModels, createProvider, createAssistantMessageEventStream, lazyStream } = await import(piAiEntry());

const UNRELATED_ENTRY = { type: "api_key", key: "unrelated-provider-key" };

const model = {
	id: "gpt-5-codex",
	name: "GPT-5 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	reasoning: true,
};

const request = { systemPrompt: "test", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

function recordingApi(seen) {
	const run = (requestModel, _context, options) => {
		seen.push({ apiKey: options?.apiKey });
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return { stream: run, streamSimple: run };
}

/** Codex-shaped provider: subscription OAuth, one chat model, a recording API implementation. */
function codexShapedProvider({ login, seen, poolAware = false, refreshed = [] }) {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex (integration check)",
		baseUrl: model.baseUrl,
		auth: {
			oauth: {
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				login,
				async refresh(credential) {
					refreshed.push(credential.refresh);
					return credential;
				},
				async toAuth(credential) {
					// Pre-request resolution of a pool reference must not touch any account.
					if (poolAware && isPoolReferenceEntry(credential)) return { apiKey: POOL_UNRESOLVED_API_KEY };
					return { apiKey: credential.access };
				},
			},
		},
		models: [model],
		api: recordingApi(seen),
	});
}

/**
 * Minimal stand-in for the streaming wrapper: it only proves that the provider can replace the
 * unresolved placeholder with a selected account before the API implementation runs. Account
 * selection and failover are implemented and tested separately.
 */
function withAccountSubstitution(native, authPath) {
	const substitute = async (options) => {
		if (options?.apiKey !== POOL_UNRESOLVED_API_KEY) return options;
		const snapshot = await loadPoolSnapshot(authPath);
		const [account] = snapshot.accounts;
		const { credential } = await ensureFreshAccountCredential({
			authPath,
			account,
			refresh: async () => { throw new Error("The integration check uses credentials that are still valid."); },
		});
		return { ...options, apiKey: credential.access };
	};
	return {
		...native,
		stream: (requestModel, context, options) => lazyStream(requestModel, async () => native.stream(requestModel, context, await substitute(options))),
		streamSimple: (requestModel, context, options) => lazyStream(requestModel, async () => native.streamSimple(requestModel, context, await substitute(options))),
	};
}

const interaction = { prompt: async () => { throw new Error("No prompt expected."); }, notify: () => {} };
const readEntries = (authPath) => JSON.parse(readFileSync(authPath, "utf8"));
/** Stored accounts also carry non-secret membership data, which is not part of the credential. */
const storedCredential = (entries, accountId) => {
	const entry = entries[poolEntryKey(accountId)];
	return entry === undefined ? undefined : accountCredential(entry);
};

// ---------------------------------------------------------------------------
// 1. A second plain login to the same provider overwrites the first account.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const credentialA = fakeCredential("account-aaaa");
		const credentialB = fakeCredential("account-bbbb");
		seedAuthFile(agent.authPath, { anthropic: UNRELATED_ENTRY, "openai-codex": credentialA });

		const seen = [];
		const models = createModels({ credentials: new NativeCredentialStore(agent.authPath) });
		models.setProvider(codexShapedProvider({ login: async () => credentialB, seen }));

		await models.login("openai-codex", "oauth", interaction);

		const entries = readEntries(agent.authPath);
		assert.deepEqual(entries["openai-codex"], credentialB, "the plain login must store the new credential");
		assert.equal(
			JSON.stringify(entries).includes(credentialA.refresh),
			false,
			"reproduced: pi keeps one credential per provider, so the first account is gone",
		);
		assert.deepEqual(entries.anthropic, UNRELATED_ENTRY, "other providers must survive a login");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// 2. The dedicated commit path keeps every account and publishes a reference.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const credentialA = fakeCredential("account-aaaa");
		const credentialB = fakeCredential("account-bbbb");
		const credentialC = fakeCredential("account-cccc");
		seedAuthFile(agent.authPath, { anthropic: UNRELATED_ENTRY, "openai-codex": credentialA });

		const first = await commitAccount({ authPath: agent.authPath, credential: credentialB });
		assert.equal(first.outcome, "added");
		assert.equal(first.migratedExistingLogin, true, "the existing plain login is kept as an account");
		assert.equal(first.accountCount, 2);

		const second = await commitAccount({ authPath: agent.authPath, credential: credentialC });
		assert.equal(second.accountCount, 3);

		let entries = readEntries(agent.authPath);
		assert.deepEqual(storedCredential(entries, "account-aaaa"), credentialA, "account A must stay unchanged");
		assert.deepEqual(storedCredential(entries, "account-bbbb"), credentialB);
		assert.deepEqual(storedCredential(entries, "account-cccc"), credentialC);
		assert.deepEqual(entries.anthropic, UNRELATED_ENTRY);

		// The main entry is a non-secret reference, and no account token leaks into it.
		const main = entries["openai-codex"];
		assert.equal(isPoolReferenceEntry(main), true);
		assert.equal(main.access, POOL_REFERENCE_TOKEN);
		assert.equal(main.refresh, POOL_REFERENCE_TOKEN);
		assert.equal(accountIdOf(main), undefined, "the reference carries no account claim, so the API cannot use it");
		for (const credential of [credentialA, credentialB, credentialC]) {
			assert.equal(JSON.stringify(main).includes(credential.access), false);
			assert.equal(JSON.stringify(main).includes(credential.refresh), false);
		}

		// Re-authorizing the same account updates it instead of adding a quota source.
		const rotatedB = fakeCredential("account-bbbb", { marker: "v2" });
		const again = await commitAccount({ authPath: agent.authPath, credential: rotatedB });
		assert.equal(again.outcome, "updated");
		assert.equal(again.accountCount, 3);
		assert.equal(again.account.ordinal, 2, "the account keeps its display number");

		entries = readEntries(agent.authPath);
		assert.deepEqual(storedCredential(entries, "account-bbbb"), rotatedB);
		assert.deepEqual(storedCredential(entries, "account-aaaa"), credentialA);
		assert.deepEqual(storedCredential(entries, "account-cccc"), credentialC);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// 3. pi resolves request auth from the reference; the provider substitutes an account.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const credentialA = fakeCredential("account-aaaa");
		seedAuthFile(agent.authPath, { "openai-codex": credentialA });
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-bbbb") });

		const seen = [];
		const refreshed = [];
		const models = createModels({ credentials: new NativeCredentialStore(agent.authPath) });
		const native = codexShapedProvider({ login: async () => { throw new Error("No login expected."); }, seen, poolAware: true, refreshed });
		models.setProvider(withAccountSubstitution(native, agent.authPath));

		const resolved = await models.getAuth(model);
		assert.equal(resolved?.auth.apiKey, POOL_UNRESOLVED_API_KEY, "pre-request resolution returns the placeholder");
		assert.deepEqual(refreshed, [], "resolving the reference must not refresh any account");

		const message = await models.streamSimple(model, request).result();
		assert.equal(message.stopReason, "stop");
		assert.equal(seen.length, 1);
		assert.equal(seen[0].apiKey, credentialA.access, "the selected account's token reaches the API implementation");
		assert.notEqual(seen[0].apiKey, POOL_UNRESOLVED_API_KEY, "the placeholder must never reach the API implementation");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// 4. Off restores one native login, and plain login semantics come back with it.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const credentialA = fakeCredential("account-aaaa");
		const credentialB = fakeCredential("account-bbbb");
		seedAuthFile(agent.authPath, { anthropic: UNRELATED_ENTRY, "openai-codex": credentialA });
		await commitAccount({ authPath: agent.authPath, credential: credentialB });

		const off = await disablePool({ authPath: agent.authPath, accountId: "account-aaaa" });
		assert.equal(off.dormantAccounts, 1);

		let entries = readEntries(agent.authPath);
		assert.deepEqual(entries["openai-codex"], credentialA, "off restores the chosen account as the plain login, without pool bookkeeping");
		assert.equal(entries[poolEntryKey("account-aaaa")], undefined, "the restored account has exactly one refresh authority");
		assert.deepEqual(storedCredential(entries, "account-bbbb"), credentialB, "the other account stays stored but dormant");
		assert.deepEqual(entries.anthropic, UNRELATED_ENTRY);

		// With the pool off, a plain login overwrites the main entry again, as pi normally does.
		const replacement = fakeCredential("account-dddd");
		const models = createModels({ credentials: new NativeCredentialStore(agent.authPath) });
		models.setProvider(codexShapedProvider({ login: async () => replacement, seen: [] }));
		await models.login("openai-codex", "oauth", interaction);

		entries = readEntries(agent.authPath);
		assert.deepEqual(entries["openai-codex"], replacement);
		assert.deepEqual(storedCredential(entries, "account-bbbb"), credentialB, "a plain login never touches isolated account entries");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// 5. Removing the last account logs openai-codex out instead of leaving a dangling reference.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { anthropic: UNRELATED_ENTRY });
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa") });
		const snapshot = await loadPoolSnapshot(agent.authPath);
		assert.equal(snapshot.enabled, true);
		assert.equal(snapshot.accounts.length, 1, "one account enables the pool but leaves no spare");

		const removal = await removeAccount({ authPath: agent.authPath, accountId: "account-aaaa" });
		assert.equal(removal.poolDisabled, true);

		const entries = readEntries(agent.authPath);
		assert.equal(entries["openai-codex"], undefined, "no reference may survive without accounts");
		assert.equal(entries[poolEntryKey("account-aaaa")], undefined);
		assert.deepEqual(entries.anthropic, UNRELATED_ENTRY);
	} finally {
		agent.dispose();
	}
}

console.log("Login ownership integration checks passed");
