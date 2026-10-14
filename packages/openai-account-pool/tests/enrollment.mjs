import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { accountIdOf, isPoolReferenceEntry, loadPoolSnapshot } from "../src/auth.ts";
import { readPreferredAccountId, recordFailure } from "../src/availability.ts";
import {
	AccountQueryError,
	endPool,
	isCancellation,
	poolStatus,
	redactMessage,
	removePoolAccount,
	resolveAccount,
	runEnrollment,
	setDefaultAccount,
} from "../src/enrollment.ts";
import { EnrollmentInProgressError } from "../src/lease.ts";
import { classifyFailure } from "../src/policy.ts";
import { poolStatePathFor, readPoolState } from "../src/store.ts";
import { fakeCredential, makeAgentDir, seedAuthFile } from "./helpers/fixtures.mjs";

const ACCOUNT_A = "account-aaaa";
const ACCOUNT_B = "account-bbbb";

/** Replays a fixed sequence of user choices and login results. */
function scriptedUi(script) {
	const views = [];
	const notes = [];
	const offered = [];
	let step = 0;
	return {
		views,
		notes,
		/** Every account list the delete dropdown was given. */
		offered,
		ui: {
			confirm: async (view) => {
				views.push(view);
				return script[step++]?.choice ?? "end";
			},
			login: async () => {
				const current = script[step - 1];
				if (current.fail) throw current.fail;
				return fakeCredential(current.account, { marker: current.marker ?? "v1", email: current.email, plan: current.plan });
			},
			pickRemoval: async (accounts) => {
				offered.push(accounts.map((account) => account.id));
				const wanted = script[step - 1]?.account;
				return accounts.find((account) => account.id === wanted);
			},
			notify: (message) => notes.push(message),
		},
	};
}

const paths = (agent) => ({ authPath: agent.authPath, statePath: poolStatePathFor(agent.directory) });

// ---------------------------------------------------------------------------
// Continue as often as the user wants: the pool is not limited to two accounts.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const { ui, views, notes } = scriptedUi([
			{ choice: "continue", account: ACCOUNT_A },
			{ choice: "continue", account: ACCOUNT_B },
			{ choice: "continue", account: "account-cccc" },
			{ choice: "continue", account: ACCOUNT_A, marker: "v2" },
			{ choice: "end" },
		]);

		const result = await runEnrollment({ ...paths(agent), ui });
		assert.deepEqual({ added: result.added, updated: result.updated, accounts: result.accounts, cancelled: result.cancelled }, { added: 3, updated: 1, accounts: 3, cancelled: false });
		assert.deepEqual(views.map((view) => view.savedAccounts), [0, 1, 2, 3, 3], "每次确认都显示真实数量");
		assert.equal(views[1].addedThisRun, 1);
		assert.match(views[1].lastOutcome, /已添加账号 #1/);
		assert.match(views[4].lastOutcome, /凭据已更新/, "re-authorizing a known account updates it in place");

		const snapshot = await loadPoolSnapshot(agent.authPath);
		assert.deepEqual(snapshot.accounts.map((account) => account.ordinal), [1, 2, 3], "ordinals stay stable across updates");
		assert.equal(snapshot.accounts.find((account) => account.id === ACCOUNT_A).ordinal, 1);
		for (const note of notes) assert.ok(!note.includes(ACCOUNT_A), "notes never spell out an account id");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// An existing plain login is kept, not replaced, by the first add.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { "openai-codex": fakeCredential(ACCOUNT_A), anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } });
		const { ui, views } = scriptedUi([{ choice: "continue", account: ACCOUNT_B }, { choice: "end" }]);

		const result = await runEnrollment({ ...paths(agent), ui });
		assert.equal(views[0].nativeLoginPending, true, "the wizard says the existing login will be kept");
		assert.equal(result.accounts, 2);
		assert.match(views[1].lastOutcome, /原有登录已保留并入池/);

		const entries = JSON.parse(readFileSync(agent.authPath, "utf8"));
		assert.ok(isPoolReferenceEntry(entries["openai-codex"]), "the main entry becomes a non-secret reference");
		assert.equal(accountIdOf(entries["openai-codex"]), undefined);
		assert.deepEqual(entries.anthropic, { type: "api_key", key: "$ANTHROPIC_API_KEY" });
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Ending right away changes nothing at all.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		seedAuthFile(agent.authPath, { "openai-codex": fakeCredential(ACCOUNT_A) });
		const before = readFileSync(agent.authPath, "utf8");
		const { ui } = scriptedUi([{ choice: "end" }]);

		const result = await runEnrollment({ ...paths(agent), ui });
		assert.deepEqual({ added: result.added, accounts: result.accounts }, { added: 0, accounts: 0 });
		assert.equal(readFileSync(agent.authPath, "utf8"), before, "native single-account login is untouched");
		assert.deepEqual((await readPoolState(poolStatePathFor(agent.directory))).accounts, {});
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A failed login is reported without retrying by itself; a cancel ends the loop.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		const failure = new Error('OpenAI Codex token exchange failed (400): {"error":"invalid_request","access_token":"sk-abcdefghijklmnopqrstuvwxyz0123456789"}');
		const { ui, views } = scriptedUi([
			{ choice: "continue", fail: failure },
			{ choice: "continue", account: ACCOUNT_A },
			{ choice: "continue", fail: new Error("Login cancelled") },
		]);

		const result = await runEnrollment({ ...paths(agent), ui });
		assert.equal(result.cancelled, true);
		assert.equal(result.accounts, 1, "an account saved before the cancel stays saved");
		assert.match(views[1].lastOutcome, /上一次登录失败/);
		assert.ok(!views[1].lastOutcome.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), "token-shaped text never reaches the user");
	} finally {
		agent.dispose();
	}
}

// Redaction keeps the shape of the error without its payload.
{
	const redacted = redactMessage(new Error('failed: https://auth.openai.com/callback?code=abc123 token "sk-0123456789abcdefghijklmnop"'));
	assert.ok(!redacted.includes("code=abc123"));
	assert.ok(!redacted.includes("sk-0123456789abcdefghijklmnop"));
	assert.match(redacted, /<url>/);
	assert.ok(isCancellation(new Error("Login cancelled")));
	assert.ok(!isCancellation(new Error("network unreachable")));
}

// ---------------------------------------------------------------------------
// Two pi processes cannot run the wizard, and two OAuth callbacks, at once.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	try {
		let releaseFirst;
		const firstReachedConfirm = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		let proceed;
		const blocked = new Promise((resolve) => {
			proceed = resolve;
		});

		const first = runEnrollment({
			...paths(agent),
			ui: {
				confirm: async () => {
					releaseFirst();
					await blocked;
					return "end";
				},
				login: async () => {
					throw new Error("not reached");
				},
				pickRemoval: async () => undefined,
				notify: () => {},
			},
		});
		await firstReachedConfirm;

		const { ui } = scriptedUi([{ choice: "end" }]);
		await assert.rejects(() => runEnrollment({ ...paths(agent), ui }), EnrollmentInProgressError);

		proceed();
		await first;
		// The lease is released, so the next wizard runs normally.
		await runEnrollment({ ...paths(agent), ui: scriptedUi([{ choice: "end" }]).ui });
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Status, off and remove speak in masked labels and keep auth.json authoritative.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	const { authPath, statePath } = paths(agent);
	try {
		const idle = await poolStatus({ authPath, statePath });
		assert.equal(idle.enabled, false);
		assert.match(idle.summary, /未启用/);

		const { ui } = scriptedUi([
			{ choice: "continue", account: ACCOUNT_A },
			{ choice: "continue", account: ACCOUNT_B },
			{ choice: "end" },
		]);
		await runEnrollment({ authPath, statePath, ui });

		const snapshot = await loadPoolSnapshot(authPath);
		const limited = snapshot.accounts.find((account) => account.id === ACCOUNT_A);
		await recordFailure({
			statePath,
			account: limited,
			now: Date.now(),
			classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1_000) + 900 } }, Date.now()),
		});

		const status = await poolStatus({ authPath, statePath });
		assert.equal(status.enabled, true);
		assert.deepEqual(status.accounts.map((account) => account.state), ["cooling", "ready"]);
		assert.match(status.accounts[0].detail, /分钟后恢复/);
		for (const line of status.accounts) assert.ok(!line.label.includes(ACCOUNT_A) && !line.label.includes(ACCOUNT_B), "status shows masked labels only");

		// Ordinals are what the user types.
		assert.equal(resolveAccount(snapshot, "2").id, ACCOUNT_B);
		assert.throws(() => resolveAccount(snapshot, "9"), AccountQueryError);

		const removed = await removePoolAccount({ authPath, statePath, accountId: ACCOUNT_B });
		assert.deepEqual({ remaining: removed.remaining, poolDisabled: removed.poolDisabled }, { remaining: 1, poolDisabled: false });
		assert.match((await poolStatus({ authPath, statePath })).summary, /暂无备用账号/);

		const ended = await endPool({ authPath, statePath });
		assert.equal(ended.kept.id, ACCOUNT_A);
		const entries = JSON.parse(readFileSync(authPath, "utf8"));
		assert.equal(isPoolReferenceEntry(entries["openai-codex"]), false, "the single-account login is authoritative again");
		assert.equal(accountIdOf(entries["openai-codex"]), ACCOUNT_A);
		assert.deepEqual((await readPoolState(statePath)).accounts, {}, "closing the pool forgets its bookkeeping");
		await assert.rejects(() => endPool({ authPath, statePath }), AccountQueryError);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// The sign-in address labels the account, so the user knows what they delete.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	const { authPath, statePath } = paths(agent);
	try {
		const { ui, views, notes, offered } = scriptedUi([
			{ choice: "continue", account: ACCOUNT_A, email: "first@example.com", plan: "plus" },
			{ choice: "continue", account: ACCOUNT_B, email: "second@example.com", plan: "pro" },
			{ choice: "remove", account: ACCOUNT_A },
			{ choice: "end" },
		]);

		const result = await runEnrollment({ authPath, statePath, ui });
		assert.deepEqual({ added: result.added, removed: result.removed, accounts: result.accounts }, { added: 2, removed: 1, accounts: 1 });
		assert.deepEqual(views[2].savedLabels, ["#1 (first@example.com)", "#2 (second@example.com)"], "the wizard lists accounts by sign-in address");
		assert.deepEqual(offered, [[ACCOUNT_A, ACCOUNT_B]], "the delete dropdown offers every saved account");
		assert.ok(notes.some((note) => note.includes("已删除账号 #1 (first@example.com)")));

		const snapshot = await loadPoolSnapshot(authPath);
		assert.deepEqual(snapshot.accounts.map((account) => account.id), [ACCOUNT_B]);
		assert.deepEqual({ email: snapshot.accounts[0].email, plan: snapshot.accounts[0].plan }, { email: "second@example.com", plan: "pro" });
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// The next-session default is shared globally and dropped with its account.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	const { authPath, statePath } = paths(agent);
	try {
		const { ui } = scriptedUi([
			{ choice: "continue", account: ACCOUNT_A, email: "first@example.com" },
			{ choice: "continue", account: ACCOUNT_B, email: "second@example.com" },
			{ choice: "end" },
		]);
		await runEnrollment({ authPath, statePath, ui });

		assert.equal(await readPreferredAccountId(statePath), undefined, "no default until the user picks one");
		const chosen = await setDefaultAccount({ authPath, statePath, accountId: ACCOUNT_B });
		assert.equal(chosen.ordinal, 2);
		assert.equal(await readPreferredAccountId(statePath), ACCOUNT_B, "the default lives in the shared state file");
		assert.equal((await poolStatus({ authPath, statePath })).accounts[1].isPreferredForNextSession, true, "status identifies the next-session preference");

		await assert.rejects(() => setDefaultAccount({ authPath, statePath, accountId: "account-unknown" }), AccountQueryError);
		assert.equal(await readPreferredAccountId(statePath), ACCOUNT_B, "a rejected pick leaves the default alone");

		await removePoolAccount({ authPath, statePath, accountId: ACCOUNT_B });
		assert.equal(await readPreferredAccountId(statePath), undefined, "deleting the default account clears the pin");

		await setDefaultAccount({ authPath, statePath, accountId: ACCOUNT_A });
		await setDefaultAccount({ authPath, statePath, accountId: undefined });
		assert.equal(await readPreferredAccountId(statePath), undefined, "auto clears the pin");
	} finally {
		agent.dispose();
	}
}

console.log("Enrollment tests passed");
