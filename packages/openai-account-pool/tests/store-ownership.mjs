import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	accountCredential,
	commitAccount,
	disablePool,
	ensureFreshAccountCredential,
	ExistingLoginNotIdentifiableError,
	isPoolReferenceEntry,
	loadPoolSnapshot,
	PoolAccountMissingError,
	PoolNotEnabledError,
	removeAccount,
} from "../src/auth.ts";
import {
	acquireEnrollmentLease,
	assertNoActiveEnrollment,
	EnrollmentInProgressError,
	EnrollmentLeaseLostError,
	withEnrollmentLease,
} from "../src/lease.ts";
import { acquireFileLock, lockDirectoryFor } from "../src/lock.ts";
import { poolEntryKey, poolStatePathFor, readPoolState, withAuthTransaction } from "../src/store.ts";
import { fakeAccessToken, fakeCredential, makeAgentDir, seedAuthFile } from "./helpers/fixtures.mjs";
import { NativeCredentialStore } from "./helpers/native-credential-store.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readEntries = (authPath) => JSON.parse(readFileSync(authPath, "utf8"));
const storedCredential = (entries, accountId) => {
	const entry = entries[poolEntryKey(accountId)];
	return entry === undefined ? undefined : accountCredential(entry);
};

const UNRELATED = {
	anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY", env: { AWS_REGION: "us-east-1" } },
	"custom-gateway": { type: "oauth", access: "gateway-access", refresh: "gateway-refresh", expires: 7, vendorField: { nested: true } },
};

// ---------------------------------------------------------------------------
// Unrelated provider entries survive every ownership change.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { ...UNRELATED, "openai-codex": fakeCredential("account-aaaa") });
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-bbbb") });
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-cccc") });
		await removeAccount({ authPath: agent.authPath, accountId: "account-cccc" });
		await disablePool({ authPath: agent.authPath, accountId: "account-bbbb" });

		const entries = readEntries(agent.authPath);
		for (const [providerId, entry] of Object.entries(UNRELATED)) {
			assert.deepEqual(entries[providerId], entry, `${providerId} must be carried through untouched`);
		}
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Pool transactions and pi's own credential writes share one lock.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { ...UNRELATED });
		const store = new NativeCredentialStore(agent.authPath);
		const lock = await acquireFileLock(agent.authPath);
		let nativeWriteFinished = false;
		const pending = store.modify("anthropic", async () => ({ type: "api_key", key: "rewritten" })).then(() => { nativeWriteFinished = true; });
		await delay(120);
		assert.equal(nativeWriteFinished, false, "pi's store must wait while the pool holds the lock");
		await lock.release();
		await pending;
		assert.equal(readEntries(agent.authPath).anthropic.key, "rewritten");

		// And the other way round: a transaction waits for a lock held elsewhere.
		const other = await acquireFileLock(agent.authPath);
		let transactionFinished = false;
		const transaction = withAuthTransaction(agent.authPath, (entries) => ({ value: { ...entries, probe: { type: "api_key", key: "x" } }, result: undefined }))
			.then(() => { transactionFinished = true; });
		await delay(120);
		assert.equal(transactionFinished, false);
		await other.release();
		await transaction;
		assert.equal(readEntries(agent.authPath).probe.key, "x");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A waiting lock acquisition is cancellable; a stale lock is reclaimed.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, {});
		const held = await acquireFileLock(agent.authPath);
		const controller = new AbortController();
		const waiting = acquireFileLock(agent.authPath, { signal: controller.signal, waitMs: 10_000 });
		setTimeout(() => controller.abort(new Error("cancelled by test")), 40);
		await assert.rejects(waiting, /cancelled by test/);
		await held.release();

		// A holder that stopped heart-beating is reclaimed instead of blocking forever.
		const directory = lockDirectoryFor(agent.authPath);
		mkdirSync(directory, { mode: 0o700 });
		const longAgo = new Date(Date.now() - 120_000);
		utimesSync(directory, longAgo, longAgo);
		const reclaimed = await acquireFileLock(agent.authPath, { waitMs: 1_000 });
		await reclaimed.release();
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A reclaimed lock refuses the write instead of corrupting the file.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { ...UNRELATED });
		const before = readFileSync(agent.authPath, "utf8");
		await assert.rejects(
			withAuthTransaction(agent.authPath, async (entries) => {
				// Simulate another process reclaiming the lock directory mid-transaction.
				const directory = lockDirectoryFor(agent.authPath);
				rmdirSync(directory);
				mkdirSync(directory, { mode: 0o700 });
				// Detection happens at write time, so it does not depend on a heartbeat having fired.
				return { value: { ...entries, injected: { type: "api_key", key: "must-not-be-written" } }, result: undefined };
			}),
			/Lost the lock/,
		);
		assert.equal(readFileSync(agent.authPath, "utf8"), before, "a compromised lock must not write");
		rmdirSync(lockDirectoryFor(agent.authPath));
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Token rotation: refreshed once under the lock, persisted, membership kept.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { ...UNRELATED });
		const expiring = fakeCredential("account-aaaa", { expiresInMs: 1_000 });
		const { account } = await commitAccount({ authPath: agent.authPath, credential: expiring });

		let refreshCalls = 0;
		const refresh = async (credential) => {
			refreshCalls += 1;
			assert.equal(credential.piOpenAIAccountPoolMembership, undefined, "the provider must see a plain credential");
			await delay(40);
			return { type: "oauth", access: fakeAccessToken("account-aaaa", "v2"), refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
		};

		const [first, second] = await Promise.all([
			ensureFreshAccountCredential({ authPath: agent.authPath, account, refresh }),
			ensureFreshAccountCredential({ authPath: agent.authPath, account, refresh }),
		]);
		assert.equal(refreshCalls, 1, "concurrent callers must exchange a rotating refresh token once");
		assert.equal(first.credential.refresh, "rotated-refresh");
		assert.equal(second.credential.refresh, "rotated-refresh");
		assert.equal(first.credential.accountId, "account-aaaa", "identity survives a refresh that omits it");

		const entries = readEntries(agent.authPath);
		assert.equal(storedCredential(entries, "account-aaaa").refresh, "rotated-refresh");
		assert.deepEqual(entries[account.key].piOpenAIAccountPoolMembership, { ordinal: account.ordinal, addedAt: account.addedAt });

		// A still-valid credential is served without any refresh call.
		const reused = await ensureFreshAccountCredential({
			authPath: agent.authPath,
			account,
			refresh: async () => { throw new Error("must not refresh a valid credential"); },
		});
		assert.equal(reused.refreshed, false);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A cancelled caller never discards a refresh that already started.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, {});
		const { account } = await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa", { expiresInMs: 1_000 }) });
		const controller = new AbortController();
		const result = await ensureFreshAccountCredential({
			authPath: agent.authPath,
			account,
			signal: controller.signal,
			refresh: async () => {
				controller.abort(new Error("request cancelled"));
				await delay(30);
				return { type: "oauth", access: fakeAccessToken("account-aaaa", "v2"), refresh: "rotated-after-cancel", expires: Date.now() + 3_600_000 };
			},
		});
		assert.equal(result.refreshed, true);
		assert.equal(storedCredential(readEntries(agent.authPath), "account-aaaa").refresh, "rotated-after-cancel");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Ownership after a plain login, a logout, and a later re-enable.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { ...UNRELATED });
		const credentialA = fakeCredential("account-aaaa");
		const credentialB = fakeCredential("account-bbbb");
		await commitAccount({ authPath: agent.authPath, credential: credentialA });
		await commitAccount({ authPath: agent.authPath, credential: credentialB });

		const store = new NativeCredentialStore(agent.authPath);

		// A plain login replaces the reference: the pool stops, accounts stay stored.
		const plain = fakeCredential("account-dddd");
		await store.modify("openai-codex", async () => plain);
		let snapshot = await loadPoolSnapshot(agent.authPath);
		assert.equal(snapshot.enabled, false);
		assert.equal(snapshot.nativeLoginPresent, true);
		assert.equal(snapshot.loggedOut, false);

		// A plain logout leaves nothing to authenticate with, and the pool must not step in.
		await store.delete("openai-codex");
		snapshot = await loadPoolSnapshot(agent.authPath);
		assert.equal(snapshot.enabled, false);
		assert.equal(snapshot.loggedOut, true);
		assert.deepEqual(snapshot.accounts, []);
		await assert.rejects(disablePool({ authPath: agent.authPath, accountId: "account-aaaa" }), PoolNotEnabledError);

		// Adding an account again re-enables the stored accounts, and says how many came back.
		const reenabled = await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-eeee") });
		assert.equal(reenabled.readoptedAccounts, 2, "previously stored accounts are brought back explicitly");
		assert.equal(reenabled.accountCount, 3);
		snapshot = await loadPoolSnapshot(agent.authPath);
		assert.deepEqual(snapshot.accounts.map((account) => account.ordinal), [1, 2, 3]);
		assert.deepEqual(storedCredential(readEntries(agent.authPath), "account-aaaa"), credentialA);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Generations only move forward, and unknown accounts fail visibly.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, {});
		const first = await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa") });
		const second = await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-bbbb") });
		const third = await commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa", { marker: "v2" }) });
		assert.ok(first.generation < second.generation && second.generation < third.generation);

		await assert.rejects(removeAccount({ authPath: agent.authPath, accountId: "account-zzzz" }), PoolAccountMissingError);
		await assert.rejects(disablePool({ authPath: agent.authPath, accountId: "account-zzzz" }), PoolAccountMissingError);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Unidentifiable and non-OAuth credentials are rejected instead of guessed.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { "openai-codex": { type: "oauth", access: "opaque-token", refresh: "opaque-refresh", expires: Date.now() + 1_000 } });
		await assert.rejects(
			commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-bbbb") }),
			ExistingLoginNotIdentifiableError,
		);
		assert.equal(isPoolReferenceEntry(readEntries(agent.authPath)["openai-codex"]), false, "a refused commit changes nothing");

		await assert.rejects(
			commitAccount({ authPath: agent.authPath, credential: { type: "api_key", key: "not-oauth" } }),
			/not an OAuth credential/,
		);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Corrupt files and unsafe paths fail visibly and are never repaired silently.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		writeFileSync(agent.authPath, "{ not json", "utf8");
		await assert.rejects(commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa") }), SyntaxError);
		assert.equal(readFileSync(agent.authPath, "utf8"), "{ not json");

		writeFileSync(agent.authPath, JSON.stringify({ "openai-codex": "not-an-object" }), "utf8");
		await assert.rejects(loadPoolSnapshot(agent.authPath), /is not an object/);

		const statePath = poolStatePathFor(agent.directory);
		mkdirSync(join(agent.directory, "openai-account-pool"), { recursive: true });
		writeFileSync(statePath, JSON.stringify({ schemaVersion: 99, policy: "sticky", accounts: {} }), "utf8");
		await assert.rejects(readPoolState(statePath), /schemaVersion 99/);
	} finally {
		agent.dispose();
	}
}
{
	const agent = makeAgentDir();
	try {
		const real = join(agent.directory, "elsewhere.json");
		writeFileSync(real, "{}", "utf8");
		symlinkSync(real, agent.authPath);
		await assert.rejects(commitAccount({ authPath: agent.authPath, credential: fakeCredential("account-aaaa") }), /not a regular file/);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Enrollment leases: exclusive, recoverable, and released.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const statePath = poolStatePathFor(agent.directory);
		const lease = await acquireEnrollmentLease({ statePath, purpose: "add account" });
		await assert.rejects(acquireEnrollmentLease({ statePath, purpose: "off" }), EnrollmentInProgressError);
		await assert.rejects(assertNoActiveEnrollment({ statePath }), /Another pi process/);

		await lease.renew();
		assert.ok(lease.record.expiresAtMs > Date.now());
		await lease.release();
		await assertNoActiveEnrollment({ statePath });
		assert.equal((await readPoolState(statePath)).enrollment, undefined);

		// An expired lease and a dead holder are both recoverable without manual cleanup.
		const expired = await acquireEnrollmentLease({ statePath, purpose: "crashed wizard", ttlMs: -1 });
		const replacement = await acquireEnrollmentLease({ statePath, purpose: "add account" });
		await replacement.release();
		await assert.rejects(expired.renew(), EnrollmentLeaseLostError);

		const statePathWithDeadHolder = statePath;
		await acquireEnrollmentLease({ statePath, purpose: "stuck" });
		const state = await readPoolState(statePathWithDeadHolder);
		writeFileSync(statePathWithDeadHolder, JSON.stringify({ ...state, enrollment: { ...state.enrollment, processId: 2 ** 22 } }, null, 2), "utf8");
		const afterCrash = await acquireEnrollmentLease({ statePath, purpose: "add account" });
		await afterCrash.release();

		// The helper releases even when the body throws.
		await assert.rejects(withEnrollmentLease({ statePath, purpose: "off" }, async () => { throw new Error("body failed"); }), /body failed/);
		await assertNoActiveEnrollment({ statePath });
	} finally {
		agent.dispose();
	}
}

console.log("Store ownership tests passed");
