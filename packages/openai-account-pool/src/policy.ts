/**
 * Pure decisions: what a failure proves, which account to use next, and whether this request may
 * still switch accounts. Nothing here reads files or the network, so every rule is testable.
 *
 * Classification reads structured evidence only. pi's Codex adapter formats a plain HTTP 429 with
 * the same "You have hit your ChatGPT usage limit" text as a real subscription limit, so matching
 * the user-facing message would switch accounts on ordinary rate limiting.
 */

export type FailureKind =
	/** The subscription's own limit is reached: the only automatic quota switch. */
	| "quota"
	/** The stored authorization is proven invalid; the account needs re-authorizing. */
	| "auth_invalid"
	/** Authentication was rejected once; the same account may be repaired first. */
	| "auth_retry"
	/** Rate limiting, network trouble or a server-side blip: retry the same account. */
	| "transient"
	| "cancelled"
	/** A definite error that another account would not fix. */
	| "fatal"
	| "unknown";

export interface ProviderErrorBody {
	code?: unknown;
	type?: unknown;
	message?: unknown;
	plan_type?: unknown;
	resets_at?: unknown;
	resets_in_seconds?: unknown;
}

export interface FailureEvidence {
	status?: number;
	body?: ProviderErrorBody;
	cancelled?: boolean;
	/** Set when the failure came from the OAuth token exchange rather than the model request. */
	oauthRefresh?: { invalidGrant: boolean };
	/** Transport-level failure such as DNS, reset connection or timeout. */
	networkFailure?: boolean;
	/** Model the request was for; quota without plan-level evidence is scoped to it. */
	modelId?: string;
}

export interface Classification {
	kind: FailureKind;
	/** Short, non-secret reason for status output and state records. */
	reason: string;
	/** Cooldown scope: the whole account, or `model:<id>` when the evidence is not plan-level. */
	scope: string;
	/** Server-stated reset time in epoch ms, or null when the server stated none. */
	serverResetAtMs: number | null;
}

export const ACCOUNT_SCOPE = "account";
const MAX_RESET_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;

function errorCode(body: ProviderErrorBody | undefined): string {
	const code = typeof body?.code === "string" ? body.code : "";
	if (code) return code.toLowerCase();
	return typeof body?.type === "string" ? body.type.toLowerCase() : "";
}

/** Only a field that is finite and lands in a plausible window counts as a reset time. */
export function serverResetAtMs(body: ProviderErrorBody | undefined, now: number): number | null {
	const inWindow = (value: number) => value > now - 24 * 60 * 60 * 1_000 && value < now + MAX_RESET_HORIZON_MS;
	if (typeof body?.resets_at === "number" && Number.isFinite(body.resets_at)) {
		// The Codex error reports epoch seconds.
		const candidate = body.resets_at * 1_000;
		if (inWindow(candidate)) return candidate;
	}
	if (typeof body?.resets_in_seconds === "number" && Number.isFinite(body.resets_in_seconds) && body.resets_in_seconds >= 0) {
		const candidate = now + body.resets_in_seconds * 1_000;
		if (inWindow(candidate)) return candidate;
	}
	return null;
}

export function classifyFailure(evidence: FailureEvidence, now: number): Classification {
	const scopeForModel = evidence.modelId ? `model:${evidence.modelId}` : ACCOUNT_SCOPE;
	const plain = (kind: FailureKind, reason: string): Classification => ({ kind, reason, scope: scopeForModel, serverResetAtMs: null });

	if (evidence.cancelled) return plain("cancelled", "cancelled");

	if (evidence.oauthRefresh) {
		// A network problem during the token exchange says nothing about the authorization.
		return evidence.oauthRefresh.invalidGrant ? plain("auth_invalid", "invalid_grant") : plain("transient", "oauth_refresh_unavailable");
	}
	if (evidence.networkFailure) return plain("transient", "network_failure");

	const code = errorCode(evidence.body);
	const status = evidence.status;

	if (code === "usage_limit_reached") {
		// A plan-level limit is shared by every model; without that evidence stay model-scoped.
		const planLevel = typeof evidence.body?.plan_type === "string" && evidence.body.plan_type.length > 0;
		return {
			kind: "quota",
			reason: "usage_limit_reached",
			scope: planLevel ? ACCOUNT_SCOPE : scopeForModel,
			serverResetAtMs: serverResetAtMs(evidence.body, now),
		};
	}
	if (code === "invalid_grant" || code === "invalid_token" || code === "token_revoked") return plain("auth_invalid", code);
	if (code === "rate_limit_exceeded") return plain("transient", "rate_limit_exceeded");
	// usage_not_included means the plan does not cover this model at all; another account is a guess.
	if (code === "usage_not_included") return plain("fatal", "usage_not_included");
	if (code === "context_length_exceeded") return plain("fatal", "context_length_exceeded");

	if (status === 401) return plain("auth_retry", "unauthorized");
	if (status === 429) return plain("transient", "http_429");
	if (status !== undefined && status >= 500) return plain("transient", `http_${status}`);
	if (status === 403) return plain("fatal", "http_403");
	if (status !== undefined && status >= 400) return plain("fatal", `http_${status}`);

	return plain("unknown", "unknown_error");
}

export interface AccountAvailability {
	id: string;
	ordinal: number;
	/** Why the account cannot be used now; undefined means usable. */
	unavailable?: { reason: string; untilMs: number | null; serverResetAtMs: number | null };
	/** The account is usable but should be probed under a lease, after a cooldown ended. */
	needsProbe: boolean;
	authInvalid: boolean;
}

export interface SelectionInput {
	accounts: AccountAvailability[];
	/** Sticky preference of this session: keep using the account that currently works. */
	preferredId?: string;
	/** Accounts this logical request already tried, so no account is tried twice. */
	attemptedIds: readonly string[];
}

/**
 * Sticky selection: stay on the preferred account while it works, otherwise take the next usable
 * account in the order they were added. Recovered accounts become candidates again.
 */
export function selectAccount(input: SelectionInput): AccountAvailability | undefined {
	const attempted = new Set(input.attemptedIds);
	const usable = input.accounts.filter((account) => !attempted.has(account.id) && !account.unavailable && !account.authInvalid);
	const preferred = usable.find((account) => account.id === input.preferredId);
	if (preferred) return preferred;
	return [...usable].sort((left, right) => left.ordinal - right.ordinal)[0];
}

export type FailoverAction =
	/** Try the next account for this same request. */
	| "failover"
	/** Re-read and refresh the current account once, then retry it. */
	| "repair"
	/** Finish the request with the provider's error. */
	| "stop";

export interface FailoverInput {
	classification: Classification;
	/** Text, thinking or a tool call already reached the caller, so nothing may be replayed. */
	emittedOutput: boolean;
	/** Another untried, usable account exists for this request. */
	hasRemainingCandidate: boolean;
	/** The current account already used its one authentication repair. */
	repairUsed: boolean;
}

export function decideFailover(input: FailoverInput): { action: FailoverAction; reason: string } {
	const { kind } = input.classification;
	if (kind === "cancelled") return { action: "stop", reason: "cancelled" };
	if (kind === "transient" || kind === "fatal" || kind === "unknown") return { action: "stop", reason: kind };
	if (input.emittedOutput) return { action: "stop", reason: "output_already_delivered" };
	if (kind === "auth_retry" && !input.repairUsed) return { action: "repair", reason: "authentication_repair" };
	// Everything below is quota or a proven authorization problem.
	if (!input.hasRemainingCandidate) return { action: "stop", reason: "pool_exhausted" };
	return { action: "failover", reason: input.classification.reason };
}
