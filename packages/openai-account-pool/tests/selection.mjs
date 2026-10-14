import assert from "node:assert/strict";

import {
	availabilityFor,
	claimProbeLease,
	DEFAULT_PROBE_BACKOFF_MS,
	readAvailability,
	recordFailure,
	recordSuccess,
	releaseProbeLease,
} from "../src/availability.ts";
import { ACCOUNT_SCOPE, classifyFailure, decideFailover, selectAccount } from "../src/policy.ts";
import { poolEntryKey, poolStatePathFor, readPoolState } from "../src/store.ts";
import { makeAgentDir } from "./helpers/fixtures.mjs";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const account = (id, { ordinal = 1, generation = 1 } = {}) => ({
	id,
	key: poolEntryKey(id),
	ordinal,
	addedAt: NOW - 1_000,
	generation,
});

// ---------------------------------------------------------------------------
// Classification reads structured evidence, never the friendly error text.
// ---------------------------------------------------------------------------
{
	const planLimit = classifyFailure(
		{ status: 429, modelId: "gpt-5-codex", body: { type: "usage_limit_reached", plan_type: "plus", resets_at: (NOW + 3_600_000) / 1_000 } },
		NOW,
	);
	assert.equal(planLimit.kind, "quota");
	assert.equal(planLimit.scope, ACCOUNT_SCOPE, "a plan-level limit applies to every model on the account");
	assert.equal(planLimit.serverResetAtMs, NOW + 3_600_000);

	const modelLimit = classifyFailure({ status: 429, modelId: "gpt-5-codex", body: { code: "usage_limit_reached" } }, NOW);
	assert.equal(modelLimit.kind, "quota");
	assert.equal(modelLimit.scope, "model:gpt-5-codex", "without plan evidence the limit stays scoped to the model");
	assert.equal(modelLimit.serverResetAtMs, null);

	// pi formats a plain 429 with the same "ChatGPT usage limit" wording as a real subscription
	// limit. Switching accounts on this would burn the pool on ordinary rate limiting.
	const plain429 = classifyFailure(
		{ status: 429, modelId: "gpt-5-codex", body: { message: "You have hit your ChatGPT usage limit. Try again later." } },
		NOW,
	);
	assert.equal(plain429.kind, "transient");

	const cases = [
		[{ status: 429, body: { code: "rate_limit_exceeded" } }, "transient"],
		[{ status: 403, body: { code: "usage_not_included" } }, "fatal"],
		[{ status: 401 }, "auth_retry"],
		[{ status: 403 }, "fatal"],
		[{ status: 400 }, "fatal"],
		[{ status: 500 }, "transient"],
		[{ status: 503 }, "transient"],
		[{ networkFailure: true }, "transient"],
		[{ oauthRefresh: { invalidGrant: true } }, "auth_invalid"],
		[{ oauthRefresh: { invalidGrant: false } }, "transient"],
		[{ status: 401, body: { code: "invalid_grant" } }, "auth_invalid"],
		[{ cancelled: true, status: 429, body: { code: "usage_limit_reached" } }, "cancelled"],
		[{}, "unknown"],
	];
	for (const [evidence, expected] of cases) {
		assert.equal(classifyFailure(evidence, NOW).kind, expected, `evidence ${JSON.stringify(evidence)}`);
	}

	// Only plausible reset times are trusted; anything else means "unknown, probe later".
	const resets = [
		[{ resets_at: 0 }, null],
		[{ resets_at: -1 }, null],
		[{ resets_at: 1e18 }, null],
		[{ resets_at: "soon" }, null],
		[{ resets_in_seconds: 3_600 }, NOW + 3_600_000],
		[{ resets_in_seconds: -5 }, null],
		[{ resets_in_seconds: 1e9 }, null],
	];
	for (const [extra, expected] of resets) {
		const classified = classifyFailure({ body: { code: "usage_limit_reached", plan_type: "pro", ...extra } }, NOW);
		assert.equal(classified.serverResetAtMs, expected, `reset evidence ${JSON.stringify(extra)}`);
	}
}

// ---------------------------------------------------------------------------
// Selection is sticky, then falls back in the order accounts were added.
// ---------------------------------------------------------------------------
{
	const usable = (id, ordinal) => ({ id, ordinal, needsProbe: false, authInvalid: false });
	const blocked = (id, ordinal) => ({ ...usable(id, ordinal), unavailable: { reason: "usage_limit_reached", untilMs: NOW + 60_000, serverResetAtMs: null } });

	const accounts = [usable("a", 1), usable("b", 2), usable("c", 3)];
	assert.equal(selectAccount({ accounts, preferredId: "c", attemptedIds: [] })?.id, "c", "keep using the account that works");
	assert.equal(selectAccount({ accounts, attemptedIds: [] })?.id, "a", "no preference means the first added account");
	assert.equal(selectAccount({ accounts, preferredId: "c", attemptedIds: ["c"] })?.id, "a", "an attempted account is never retried");
	assert.equal(
		selectAccount({ accounts: [blocked("a", 1), usable("b", 2)], preferredId: "a", attemptedIds: [] })?.id,
		"b",
		"a cooled-down preference yields to the next usable account",
	);
	assert.equal(
		selectAccount({ accounts: [{ ...usable("a", 1), authInvalid: true }, usable("b", 2)], attemptedIds: [] })?.id,
		"b",
		"an account needing re-authorization is skipped",
	);
	assert.equal(selectAccount({ accounts: [blocked("a", 1), blocked("b", 2)], attemptedIds: [] }), undefined);
	assert.equal(selectAccount({ accounts, attemptedIds: ["a", "b", "c"] }), undefined);
}

// ---------------------------------------------------------------------------
// Failover is bounded: only proven quota or authorization failures switch accounts,
// and never after output already reached the caller.
// ---------------------------------------------------------------------------
{
	const quota = classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, NOW);
	const base = { emittedOutput: false, hasRemainingCandidate: true, repairUsed: false };

	assert.deepEqual(decideFailover({ ...base, classification: quota }), { action: "failover", reason: "usage_limit_reached" });
	assert.equal(decideFailover({ ...base, classification: quota, emittedOutput: true }).action, "stop");
	assert.equal(decideFailover({ ...base, classification: quota, emittedOutput: true }).reason, "output_already_delivered");
	assert.equal(decideFailover({ ...base, classification: quota, hasRemainingCandidate: false }).reason, "pool_exhausted");

	const unauthorized = classifyFailure({ status: 401 }, NOW);
	assert.equal(decideFailover({ ...base, classification: unauthorized }).action, "repair", "first 401 retries the same account");
	assert.equal(
		decideFailover({ ...base, classification: unauthorized, repairUsed: true }).action,
		"failover",
		"a 401 that survives one repair means this account is out",
	);

	for (const evidence of [{ status: 500 }, { status: 403 }, {}, { cancelled: true }]) {
		assert.equal(decideFailover({ ...base, classification: classifyFailure(evidence, NOW) }).action, "stop", JSON.stringify(evidence));
	}
}

// ---------------------------------------------------------------------------
// Shared state: cooldowns, generations, probe leases.
// ---------------------------------------------------------------------------
{
	const agent = makeAgentDir();
	const statePath = poolStatePathFor(agent.directory);
	try {
		const first = account("account-aaaa", { ordinal: 1 });
		const second = account("account-bbbb", { ordinal: 2 });
		const accounts = [first, second];

		// A limit with a server-stated reset blocks exactly until that time.
		await recordFailure({
			statePath,
			account: first,
			now: NOW,
			classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus", resets_at: (NOW + 600_000) / 1_000 } }, NOW),
		});
		let view = await readAvailability({ statePath, accounts, now: NOW + 1_000 });
		assert.equal(view[0].unavailable?.reason, "usage_limit_reached");
		assert.equal(view[0].unavailable?.untilMs, NOW + 600_000);
		assert.equal(view[1].unavailable, undefined, "one account's limit says nothing about another");
		assert.equal(selectAccount({ accounts: view, preferredId: first.id, attemptedIds: [] })?.id, second.id);

		// Past the reset the account is a candidate again, flagged for a probe.
		view = await readAvailability({ statePath, accounts, now: NOW + 600_001 });
		assert.equal(view[0].unavailable, undefined);
		assert.equal(view[0].needsProbe, true);

		// A success from a request that started before the limit must not clear it.
		await recordSuccess({ statePath, account: first, requestStartedAtMs: NOW - 5_000 });
		view = await readAvailability({ statePath, accounts, now: NOW + 1_000 });
		assert.equal(view[0].unavailable?.reason, "usage_limit_reached", "an older request's success is stale evidence");

		// A success from a later request does clear it.
		await recordSuccess({ statePath, account: first, requestStartedAtMs: NOW + 1 });
		view = await readAvailability({ statePath, accounts, now: NOW + 1_000 });
		assert.equal(view[0].unavailable, undefined);
		assert.equal(view[0].needsProbe, false, "cleared evidence leaves no probe obligation");
	}
	finally {
		agent.dispose();
	}
}

// Re-authorizing an account retires every record written for the older generation.
{
	const agent = makeAgentDir();
	const statePath = poolStatePathFor(agent.directory);
	try {
		const before = account("account-aaaa", { generation: 3 });
		await recordFailure({ statePath, account: before, now: NOW, classification: classifyFailure({ oauthRefresh: { invalidGrant: true } }, NOW) });
		await recordFailure({ statePath, account: before, now: NOW, classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, NOW) });

		let view = await readAvailability({ statePath, accounts: [before], now: NOW + 1_000 });
		assert.equal(view[0].authInvalid, true);
		assert.equal(view[0].unavailable?.untilMs, NOW + DEFAULT_PROBE_BACKOFF_MS, "an unknown reset falls back to a short local backoff");

		const after = account("account-aaaa", { generation: 4 });
		view = await readAvailability({ statePath, accounts: [after], now: NOW + 1_000 });
		assert.equal(view[0].authInvalid, false, "a fresh authorization clears the invalid mark");
		assert.equal(view[0].unavailable, undefined, "evidence from the previous authorization no longer applies");

		// Evidence arriving late from the old generation must not overwrite the newer record.
		await recordFailure({ statePath, account: after, now: NOW + 2_000, classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, NOW + 2_000) });
		await recordFailure({ statePath, account: before, now: NOW + 3_000, classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, NOW + 3_000) });
		const state = await readPoolState(statePath);
		assert.equal(state.accounts["account-aaaa"].cooldowns[ACCOUNT_SCOPE].generation, 4, "stale evidence never outranks a newer login");
	}
	finally {
		agent.dispose();
	}
}

// A model-scoped limit leaves other models on the same account usable.
{
	const agent = makeAgentDir();
	const statePath = poolStatePathFor(agent.directory);
	try {
		const only = account("account-aaaa");
		await recordFailure({ statePath, account: only, now: NOW, classification: classifyFailure({ modelId: "gpt-5-codex", body: { code: "usage_limit_reached" } }, NOW) });
		const blockedModel = await readAvailability({ statePath, accounts: [only], now: NOW + 1_000, modelId: "gpt-5-codex" });
		const otherModel = await readAvailability({ statePath, accounts: [only], now: NOW + 1_000, modelId: "gpt-5-mini" });
		assert.equal(blockedModel[0].unavailable?.reason, "usage_limit_reached");
		assert.equal(otherModel[0].unavailable, undefined);
	}
	finally {
		agent.dispose();
	}
}

// Only one process probes a recovered account; the others keep using what works.
{
	const agent = makeAgentDir();
	const statePath = poolStatePathFor(agent.directory);
	try {
		const recovered = account("account-aaaa", { ordinal: 1 });
		const healthy = account("account-bbbb", { ordinal: 2 });
		const accounts = [recovered, healthy];
		await recordFailure({ statePath, account: recovered, now: NOW, classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, NOW) });

		const probeTime = NOW + DEFAULT_PROBE_BACKOFF_MS + 1;
		assert.equal(await claimProbeLease({ statePath, accountId: recovered.id, owner: "process-a", now: probeTime, ttlMs: 30_000 }), true);
		assert.equal(
			await claimProbeLease({ statePath, accountId: recovered.id, owner: "process-b", now: probeTime, ttlMs: 30_000 }),
			false,
			"a live probe lease is exclusive",
		);

		const state = await readPoolState(statePath);
		const forOwner = availabilityFor({ accounts, state, now: probeTime, probeOwner: "process-a" });
		const forOther = availabilityFor({ accounts, state, now: probeTime, probeOwner: "process-b" });
		assert.equal(forOwner[0].unavailable, undefined, "the lease holder may probe");
		assert.equal(forOther[0].unavailable?.reason, "probe_in_progress");
		assert.equal(selectAccount({ accounts: forOther, attemptedIds: [] })?.id, healthy.id);

		// An abandoned lease expires instead of blocking recovery forever.
		assert.equal(await claimProbeLease({ statePath, accountId: recovered.id, owner: "process-b", now: probeTime + 30_001 }), true);

		await releaseProbeLease({ statePath, accountId: recovered.id, owner: "process-a" });
		assert.ok((await readPoolState(statePath)).accounts[recovered.id].probeLease, "only the owner may release the lease");
		await releaseProbeLease({ statePath, accountId: recovered.id, owner: "process-b" });
		assert.equal((await readPoolState(statePath)).accounts[recovered.id].probeLease, undefined);

		// Recording a fresh limit drops the lease with it.
		await claimProbeLease({ statePath, accountId: recovered.id, owner: "process-b", now: probeTime });
		await recordFailure({ statePath, account: recovered, now: probeTime, classification: classifyFailure({ body: { code: "usage_limit_reached", plan_type: "plus" } }, probeTime) });
		assert.equal((await readPoolState(statePath)).accounts[recovered.id].probeLease, undefined);
	}
	finally {
		agent.dispose();
	}
}

// Transient and fatal failures leave no shared state behind.
{
	const agent = makeAgentDir();
	const statePath = poolStatePathFor(agent.directory);
	try {
		const only = account("account-aaaa");
		for (const evidence of [{ status: 429 }, { status: 500 }, { status: 403 }, { cancelled: true }, {}]) {
			await recordFailure({ statePath, account: only, now: NOW, classification: classifyFailure(evidence, NOW) });
		}
		assert.deepEqual((await readPoolState(statePath)).accounts, {}, "only proven limits and authorization failures are shared");
	}
	finally {
		agent.dispose();
	}
}

console.log("Selection policy tests passed");
