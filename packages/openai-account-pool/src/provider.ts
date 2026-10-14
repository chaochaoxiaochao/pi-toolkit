import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ModelAuth,
	OAuthCredential,
	Provider,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";

import {
	ensureFreshAccountCredential,
	isPoolReferenceEntry,
	loadPoolSnapshot,
	maskAccountId,
	POOL_UNRESOLVED_API_KEY,
	type PoolAccount,
	type PoolSnapshot,
} from "./auth.ts";
import { claimProbeLease, readAvailability, recordFailure, recordSuccess, releaseProbeLease } from "./availability.ts";
import {
	classifyFailure,
	decideFailover,
	selectAccount,
	type AccountAvailability,
	type Classification,
	type FailureEvidence,
	type ProviderErrorBody,
} from "./policy.ts";
import { readPoolState, type AuthEntry } from "./store.ts";
import { describeSoonestReady, refreshPoolUsage } from "./usage.ts";

/**
 * Wraps the built-in `openai-codex` provider so one model request can be retried on another
 * pooled account. The wrapper only ever adds account selection: the request itself, including
 * every caller callback, still runs through the built-in adapter.
 */

/** Error bodies are small; read enough to classify and no more. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Events held back before the first real output, so a dead attempt can still be discarded. */
const MAX_BUFFERED_EVENTS = 64;

export interface PoolRuntime {
	/** pi-ai's `lazyStream`, injected so this module needs no runtime import of pi-ai. */
	lazyStream: (model: Model<Api>, setup: () => Promise<AsyncIterable<AssistantMessageEvent>>) => AssistantMessageEventStream;
	authPath: string;
	statePath: string;
	/** Global preference sampled when this session started. Later writes apply to later sessions. */
	preferredAccountId?: string;
	now?: () => number;
	/** Identifies this process while probing a recovered account. */
	probeOwner?: string;
	/** Shows a short, non-secret note when the pool switches or gives up. */
	notify?: (message: string) => void;
	/** Test seam for the private usage endpoint; ordinary model requests do not use it. */
	usageFetch?: typeof globalThis.fetch;
}

type StreamKind = "stream" | "streamSimple";

function isMeaningfulOutput(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "text_end":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_delta":
		case "toolcall_end":
		case "done":
			return true;
		default:
			return false;
	}
}

async function readBoundedText(response: Response): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < MAX_ERROR_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES));
}

function errorBodyOf(payload: unknown): ProviderErrorBody | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	const nested = record.error;
	if (typeof nested === "object" && nested !== null) return nested as ProviderErrorBody;
	if (typeof record.code === "string" || typeof record.type === "string") return record as ProviderErrorBody;
	return undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted");
}

/**
 * Observes the provider's own HTTP responses and stream events to learn what actually failed.
 * The adapter's user-facing message cannot be used: it formats a plain 429 with the same
 * "ChatGPT usage limit" wording as a real subscription limit.
 */
function instrument<TOptions extends StreamOptions>(options: TOptions | undefined, apiKey: string, modelId: string): { options: TOptions; evidence: () => FailureEvidence } {
	let status: number | undefined;
	let body: ProviderErrorBody | undefined;
	let networkFailure = false;

	const innerFetch = options?.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
	const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
		let response: Response;
		try {
			response = await innerFetch(input, init);
		} catch (error) {
			if (!isAbortError(error)) networkFailure = true;
			throw error;
		}
		if (!response.ok) {
			status = response.status;
			try {
				body = errorBodyOf(JSON.parse(await readBoundedText(response.clone()))) ?? body;
			} catch {
				// An unparsable error body still leaves the status as evidence.
			}
		}
		return response;
	};

	const innerStreamEvent = options?.onProviderStreamEvent;
	const wrappedStreamEvent = async (data: unknown, model: Model<Api>) => {
		try {
			const event = data as { type?: unknown; response?: unknown } | null;
			if (event && typeof event === "object") {
				const failed = event.type === "response.failed" ? errorBodyOf(event.response) : undefined;
				body = failed ?? (event.type === "error" ? errorBodyOf(event) : undefined) ?? body;
			}
		} catch {
			// Observation must never break the request.
		}
		await innerStreamEvent?.(data, model);
	};

	return {
		options: { ...(options ?? ({} as TOptions)), apiKey, fetch: wrappedFetch, onProviderStreamEvent: wrappedStreamEvent },
		evidence: () => ({ status, body, networkFailure, modelId }),
	};
}

/** Classifies a failed token exchange without putting the response text anywhere. */
function classifyRefreshError(error: unknown, modelId: string, now: number): Classification {
	const message = error instanceof Error ? error.message : String(error);
	if (isAbortError(error) || message.includes("Login cancelled")) return classifyFailure({ cancelled: true, modelId }, now);
	// OAuth reports a proven-dead grant with this exact protocol code.
	const invalidGrant = /"error"\s*:\s*"invalid_grant"|\binvalid_grant\b/.test(message);
	return classifyFailure({ oauthRefresh: { invalidGrant }, modelId }, now);
}

type AttemptOutcome =
	| { kind: "success" }
	| { kind: "stop" }
	| { kind: "failover"; classification: Classification }
	| { kind: "repair"; classification: Classification };

export function createPoolProvider(base: Provider, runtime: PoolRuntime): Provider {
	const now = runtime.now ?? (() => Date.now());
	const probeOwner = runtime.probeOwner ?? `pid-${process.pid}`;
	const oauth = base.auth.oauth;
	/** Sticky account of this session: start from its sampled preference, then keep what works. */
	let sticky = runtime.preferredAccountId;

	const refreshWith = async (credential: AuthEntry, signal: AbortSignal | undefined): Promise<AuthEntry> => {
		if (!oauth) throw new Error("openai-codex provider has no OAuth support.");
		const refreshed = await oauth.refresh(credential as unknown as OAuthCredential, signal ?? new AbortController().signal);
		return refreshed as unknown as AuthEntry;
	};

	/** The pool only applies to the provider's own Codex endpoint with pool-resolved auth. */
	const usesPool = (model: Model<Api>, options: StreamOptions | undefined): boolean => {
		if (options?.apiKey !== POOL_UNRESOLVED_API_KEY) return false;
		if (!base.baseUrl) return true;
		return model.baseUrl.startsWith(base.baseUrl);
	};

	function poolExhaustedText(availability: readonly AccountAvailability[]): string {
		return `ChatGPT 账号池暂时都不可用（${describeUnavailable(availability)}）。可用 /codex_pool status 查看，或 /codex_pool 添加账号。`;
	}

	async function poolExhaustedMessage(model: Model<Api>, accounts: readonly PoolAccount[]): Promise<string> {
		const availability = await readAvailability({ statePath: runtime.statePath, accounts, now: now(), modelId: model.id, probeOwner });
		return poolExhaustedTextWithRecovery(availability, accounts, model.id);
	}

	async function poolExhaustedTextWithRecovery(availability: readonly AccountAvailability[], accounts: readonly PoolAccount[], modelId: string): Promise<string> {
		const basic = poolExhaustedText(availability);
		const at = now();
		const recovery = describeSoonestReady({ accounts, state: await readPoolState(runtime.statePath), now: at, modelId });
		return recovery ? `${basic} ${recovery}。` : basic;
	}

	function describeUnavailable(availability: readonly AccountAvailability[]): string {
		const parts = availability.map((entry) => {
			const label = maskAccountId(entry.id);
			if (entry.authInvalid) return `${label}：需要重新授权`;
			const until = entry.unavailable?.serverResetAtMs;
			if (until) return `${label}：约 ${Math.max(1, Math.round((until - now()) / 60_000))} 分钟后恢复`;
			if (entry.unavailable?.reason === "probe_in_progress") return `${label}：另一个进程正在重试`;
			return `${label}：恢复时间未知`;
		});
		return parts.join("；");
	}

	/**
	 * Runs one attempt on one account. Events are held back until real output appears, so an
	 * attempt that fails with nothing to show can be dropped and retried on another account.
	 */
	async function* runAttempt(
		inner: AsyncIterable<AssistantMessageEvent>,
		evidence: () => FailureEvidence,
		contextOf: {
			signal?: AbortSignal;
			repairUsed: boolean;
			hasRemainingCandidate: boolean;
			// A terminal event ends the caller's iteration, so shared state is written before it.
			beforeStop: (classification: Classification) => Promise<void>;
			beforeSuccess: () => Promise<void>;
		},
	): AsyncGenerator<AssistantMessageEvent, AttemptOutcome> {
		const buffered: AssistantMessageEvent[] = [];
		let flushed = false;

		for await (const event of inner) {
			if (event.type === "error") {
				const cancelled = contextOf.signal?.aborted || event.reason === "aborted";
				const classification = classifyFailure({ ...evidence(), cancelled }, now());
				const decision = decideFailover({
					classification,
					emittedOutput: flushed,
					hasRemainingCandidate: contextOf.hasRemainingCandidate,
					repairUsed: contextOf.repairUsed,
				});
				if (decision.action === "stop") {
					await contextOf.beforeStop(classification);
					yield* buffered;
					yield event;
					return { kind: "stop" };
				}
				return { kind: decision.action === "repair" ? "repair" : "failover", classification };
			}
			if (event.type === "done") {
				await contextOf.beforeSuccess();
				yield* buffered;
				yield event;
				return { kind: "success" };
			}
			if (flushed) {
				yield event;
				continue;
			}
			buffered.push(event);
			if (isMeaningfulOutput(event) || buffered.length >= MAX_BUFFERED_EVENTS) {
				flushed = true;
				yield* buffered;
				buffered.length = 0;
			}
		}
		yield* buffered;
		throw new Error("Codex 响应在结束前中断。");
	}

	async function* runWithPool(
		kind: StreamKind,
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | SimpleStreamOptions | undefined,
		snapshot: PoolSnapshot,
	): AsyncGenerator<AssistantMessageEvent> {
		const attempted: string[] = [];
		const repaired = new Set<string>();
		let lastAvailability: readonly AccountAvailability[] = [];
		let usageRefreshAttempted = false;

		while (true) {
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const availability = await readAvailability({
				statePath: runtime.statePath,
				accounts: snapshot.accounts,
				now: now(),
				modelId: model.id,
				probeOwner,
			});
			lastAvailability = availability;
			const chosen = selectAccount({ accounts: availability, preferredId: sticky, attemptedIds: attempted });
			if (!chosen) {
				// Query live usage only when the request began with no local candidate. Once a
				// model attempt has failed, a sweep must not erase `attempted` and replay it.
				if (!usageRefreshAttempted && attempted.length === 0) {
					usageRefreshAttempted = true;
					await refreshPoolUsage({
						authPath: runtime.authPath,
						statePath: runtime.statePath,
						accounts: snapshot.accounts,
						refresh: refreshWith,
						now,
						fetch: runtime.usageFetch,
						signal: options?.signal,
					});
					attempted.length = 0;
					continue;
				}
				break;
			}

			const account = snapshot.accounts.find((candidate) => candidate.id === chosen.id);
			if (!account) break;
			attempted.push(account.id);

			// A recovered account is retried by one process at a time, not by all of them at once.
			let holdsProbe = false;
			if (chosen.needsProbe) {
				holdsProbe = await claimProbeLease({ statePath: runtime.statePath, accountId: account.id, owner: probeOwner, now: now() });
				if (!holdsProbe) continue;
			}

			try {
				const outcome = yield* attemptAccount(kind, model, context, options, account, {
					repairUsed: repaired.has(account.id),
					clearsState: chosen.needsProbe || chosen.authInvalid,
					hasRemainingCandidate: availability.some(
						(entry) => !attempted.includes(entry.id) && !entry.unavailable && !entry.authInvalid,
					),
					markRepaired: () => repaired.add(account.id),
				}, snapshot.accounts);
				if (outcome.kind === "success" || outcome.kind === "stop") return;
				if (outcome.kind === "repair") {
					// The repair retries the same account and does not consume a failover candidate.
					attempted.pop();
					continue;
				}
				const next = selectAccount({
					accounts: await readAvailability({ statePath: runtime.statePath, accounts: snapshot.accounts, now: now(), modelId: model.id, probeOwner }),
					preferredId: undefined,
					attemptedIds: attempted,
				});
				if (next) {
					runtime.notify?.(
						outcome.classification.kind === "quota"
							? `Codex 账号 ${maskAccountId(account.id)} 额度已用尽，切换到 ${maskAccountId(next.id)}。`
							: `Codex 账号 ${maskAccountId(account.id)} 需要重新授权，切换到 ${maskAccountId(next.id)}。`,
					);
				}
			} finally {
				if (holdsProbe) await releaseProbeLease({ statePath: runtime.statePath, accountId: account.id, owner: probeOwner }).catch(() => {});
			}
		}

		throw new Error(await poolExhaustedTextWithRecovery(lastAvailability, snapshot.accounts, model.id));
	}

	async function* attemptAccount(
		kind: StreamKind,
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | SimpleStreamOptions | undefined,
		account: PoolAccount,
		gate: { repairUsed: boolean; hasRemainingCandidate: boolean; clearsState: boolean; markRepaired: () => void },
		snapshotAccounts: readonly PoolAccount[],
	): AsyncGenerator<AssistantMessageEvent, AttemptOutcome> {
		const requestStartedAtMs = now();
		let credential: AuthEntry;
		try {
			const fresh = await ensureFreshAccountCredential({
				authPath: runtime.authPath,
				account,
				refresh: (current) => refreshWith(current, options?.signal),
				signal: options?.signal,
			});
			credential = fresh.credential;
		} catch (error) {
			const classification = classifyRefreshError(error, model.id, now());
			await recordFailure({ statePath: runtime.statePath, account, classification, now: now() });
			const decision = decideFailover({ classification, emittedOutput: false, hasRemainingCandidate: gate.hasRemainingCandidate, repairUsed: true });
			if (decision.action !== "failover") {
				// The raw token response may echo request details, so only the reason code is surfaced.
				if (classification.kind === "cancelled") throw new Error("Request was aborted");
				throw new Error(`Codex 账号 ${maskAccountId(account.id)} 凭据刷新失败（${classification.reason}）。`);
			}
			return { kind: "failover", classification };
		}

		const instrumented = instrument(options, String(credential.access), model.id);
		const inner =
			kind === "stream"
				? base.stream(model, context, instrumented.options)
				: base.streamSimple(model, context, instrumented.options as SimpleStreamOptions);

		const outcome = yield* runAttempt(inner, instrumented.evidence, {
			signal: options?.signal,
			repairUsed: gate.repairUsed,
			hasRemainingCandidate: gate.hasRemainingCandidate,
			beforeStop: async (classification) => {
				await recordFailure({ statePath: runtime.statePath, account, classification, now: now() });
				const exhausting = classification.kind === "quota" || classification.kind === "auth_invalid";
				// The provider's own error is forwarded untouched, so the pool status is a separate note.
				if (exhausting && !gate.hasRemainingCandidate) runtime.notify?.(await poolExhaustedMessage(model, snapshotAccounts));
			},
				beforeSuccess: async () => {
					sticky = account.id;
					await recordSuccess({ statePath: runtime.statePath, account, requestStartedAtMs, clearEvidence: gate.clearsState });
				},
		});

		if (outcome.kind === "success") return outcome;
		if (outcome.kind === "repair") {
			gate.markRepaired();
			try {
				// Re-read and rotate the exact token that was rejected, once.
				await ensureFreshAccountCredential({
					authPath: runtime.authPath,
					account,
					refresh: (current) => refreshWith(current, options?.signal),
					force: true,
					staleAccess: String(credential.access),
					signal: options?.signal,
				});
			} catch (error) {
				const classification = classifyRefreshError(error, model.id, now());
				await recordFailure({ statePath: runtime.statePath, account, classification, now: now() });
				return { kind: "failover", classification };
			}
			return outcome;
		}
		if (outcome.kind === "failover") {
			await recordFailure({ statePath: runtime.statePath, account, classification: outcome.classification, now: now() });
		}
		return outcome;
	}

	const streamThroughPool = (kind: StreamKind) => (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
		runtime.lazyStream(model, async () => {
			if (!usesPool(model, options)) {
				return kind === "stream" ? base.stream(model, context, options) : base.streamSimple(model, context, options as SimpleStreamOptions);
			}
			const snapshot = await loadPoolSnapshot(runtime.authPath);
			if (!snapshot.enabled || snapshot.accounts.length === 0) {
				throw new Error("ChatGPT 账号池已启用但没有可用账号，请运行 /codex_pool 添加账号。");
			}
			return runWithPool(kind, model, context, options, snapshot);
		});

	const wrapped: Provider = {
		...base,
		auth: oauth
			? {
					...base.auth,
					oauth: {
						...oauth,
						// The stored pool reference is not a token: requests resolve a real account later.
						toAuth: async (credential): Promise<ModelAuth> =>
							isPoolReferenceEntry(credential as unknown as AuthEntry) ? { apiKey: POOL_UNRESOLVED_API_KEY } : oauth.toAuth(credential),
						refresh: async (credential, signal): Promise<OAuthCredential> =>
							isPoolReferenceEntry(credential as unknown as AuthEntry) ? credential : oauth.refresh(credential, signal),
					},
				}
			: base.auth,
		stream: streamThroughPool("stream") as Provider["stream"],
		streamSimple: streamThroughPool("streamSimple") as Provider["streamSimple"],
	};

	// Deferred responses belong to the account that started them, so they resolve auth without
	// failover rather than inheriting the unresolved placeholder.
	if (base.fetchDeferred) {
		wrapped.fetchDeferred = (model, handle, options) =>
			runtime.lazyStream(model, async () => base.fetchDeferred!(model, handle, await resolveDeferredOptions(model, options)));
	}
	if (base.cancelDeferred) {
		wrapped.cancelDeferred = async (model, handle, options) => base.cancelDeferred!(model, handle, await resolveDeferredOptions(model, options));
	}

	async function resolveDeferredOptions<TOptions extends { apiKey?: string; signal?: AbortSignal }>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<TOptions | undefined> {
		if (!usesPool(model, options as StreamOptions | undefined)) return options;
		const snapshot = await loadPoolSnapshot(runtime.authPath);
		const byId = (wanted: string | undefined) => (wanted ? snapshot.accounts.find((candidate) => candidate.id === wanted) : undefined);
		const account = byId(sticky) ?? snapshot.accounts[0];
		if (!account) throw new Error("ChatGPT 账号池没有可用账号，请运行 /codex_pool 添加账号。");
		const fresh = await ensureFreshAccountCredential({
			authPath: runtime.authPath,
			account,
			refresh: (current) => refreshWith(current, options?.signal),
			signal: options?.signal,
		});
		return { ...(options as TOptions), apiKey: String(fresh.credential.access) };
	}

	return wrapped;
}
