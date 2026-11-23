import { randomUUID } from "node:crypto";
import {
	createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError,
	type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type Provider,
	type SimpleStreamOptions, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { TURN_TIMEOUT_MS } from "../guest/protocol.mjs";
import type { CageProfile } from "./profile.ts";
import { isRecord, requestCage, withAbort } from "./transport.ts";

export const PROVIDER_ID = "claude-cage";
export const API_ID = "claude-cage";
const BASE_URL = "process://claude-cage";
const REASONING = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const PARTIAL_EVENTS = new Set([
	"text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end",
	"toolcall_start", "toolcall_delta", "toolcall_end",
]);

type WireOptions = Pick<SimpleStreamOptions, "reasoning" | "maxTokens" | "cacheRetention" | "timeoutMs">;

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validCosts(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && COST_FIELDS.every((key) => nonNegative(value[key]));
}

function wireOptions(options: Partial<Record<keyof WireOptions, unknown>>): WireOptions {
	const safe: WireOptions = {};
	const reasoning = REASONING.find((level) => level === options.reasoning);
	if (reasoning) safe.reasoning = reasoning;
	if (positiveInteger(options.maxTokens)) safe.maxTokens = options.maxTokens;
	if (options.cacheRetention === "none" || options.cacheRetention === "short" || options.cacheRetention === "long") {
		safe.cacheRetention = options.cacheRetention;
	}
	if (positiveInteger(options.timeoutMs)) safe.timeoutMs = Math.min(options.timeoutMs, TURN_TIMEOUT_MS);
	return safe;
}

function publicModel(model: Model<Api>): Model<Api> {
	const { id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap } = model;
	const { input: inCost, output, cacheRead, cacheWrite, tiers } = model.cost;
	return {
		id, name, reasoning, input, contextWindow, maxTokens, type: "chat", provider: PROVIDER_ID, api: API_ID,
		baseUrl: BASE_URL,
		cost: {
			input: inCost, output, cacheRead, cacheWrite,
			...(tiers ? { tiers: tiers.map(({ input, output, cacheRead, cacheWrite, inputTokensAbove }) =>
				({ input, output, cacheRead, cacheWrite, inputTokensAbove })) } : {}),
		},
		...(thinkingLevelMap ? { thinkingLevelMap: Object.fromEntries(
			["off", ...REASONING].flatMap((level) => {
				const setting = thinkingLevelMap[level as keyof typeof thinkingLevelMap];
				return setting === null || typeof setting === "string" ? [[level, setting]] : [];
			}),
		) } : {}),
	};
}

export function parseModels(value: unknown): Model<Api>[] {
	if (!Array.isArray(value)) throw new Error("Invalid Cage model catalog");
	const ids = new Set<string>();
	return value.map((model) => {
		if (!isRecord(model) || (model.type !== undefined && model.type !== "chat") ||
			typeof model.id !== "string" || model.id.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/.test(model.id) ||
			ids.has(model.id) || typeof model.name !== "string" || !model.name.trim() || /[\x00-\x1f\x7f]/.test(model.name) ||
			typeof model.reasoning !== "boolean" || !Array.isArray(model.input) || !model.input.length ||
			!model.input.every((input: unknown) => input === "text" || input === "image") ||
			!positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens) || !validCosts(model.cost) ||
			(model.cost.tiers !== undefined && (!Array.isArray(model.cost.tiers) ||
				!model.cost.tiers.every((tier: unknown) => validCosts(tier) && nonNegative(tier.inputTokensAbove))))) {
			throw new Error("Invalid or duplicate model in the Cage catalog");
		}
		ids.add(model.id);
		return publicModel(model as unknown as Model<Api>);
	});
}

function newMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant", model: model.id, provider: model.provider, api: model.api, content: [],
		stopReason: "pending", timestamp: Date.now(),
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function checkedMessage(value: unknown, model: Model<Api>): AssistantMessage {
	if (!isRecord(value) || value.role !== "assistant" || value.model !== model.id || value.provider !== model.provider ||
		value.api !== model.api || !Array.isArray(value.content) || !nonNegative(value.timestamp) ||
		!validCosts(value.usage) || !nonNegative(value.usage.totalTokens) ||
		!validCosts(value.usage.cost) || !nonNegative(value.usage.cost.total)) {
		throw new Error("Invalid assistant message from the Cage proxy");
	}
	return value as unknown as AssistantMessage;
}

function safeFailure(message: AssistantMessage, detail: string, aborted: boolean): AssistantMessage {
	const result: AssistantMessage = {
		...message, stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "Claude Cage request cancelled." :
			`Claude Cage: ${detail.slice(0, 800).replace(/[\x00-\x1f\x7f]/g, " ").trim() || "request failed"}`,
	};
	// Pi classifies error text, not a structured retry flag. A proxy cannot prove
	// that Claude did not receive a turn, even if no assistant event arrived.
	// Keep failure text that would trigger backoff or recovery out of that field.
	if (isContextOverflow(result)) {
		result.errorMessage = "Claude Cage could not fit this transcript. Shorten it or compact manually before sending a new request.";
	} else if (isRetryableAssistantError(result)) {
		result.errorMessage = "Claude Cage could not complete the request. Automatic replay is disabled; check the configured guest.";
	}
	return result;
}

export function createCageProvider(profile: CageProfile | undefined, profileError?: string, cachedModels: Model<Api>[] = []) {
	let catalog = cachedModels;
	let submitted = false;
	const sessionId = randomUUID();
	const lifecycle = new AbortController();
	const active = new Set<Promise<void>>();
	let shutdown: Promise<void> | undefined;

	function stream(model: Model<Api>, context: TranscriptContext, options: StreamOptions & { reasoning?: unknown } = {}) {
		const output = createAssistantMessageEventStream();
		const signal = options.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal;
		let latest = newMessage(model);
		let started = false;

		async function observe(event: Record<string, unknown>) {
			await options.onProviderStreamEvent?.(event, model);
			signal.throwIfAborted();
			if (event.type === "done" || event.type === "error") return;
			if (event.type === "start" ? started : !started || typeof event.type !== "string" || !PARTIAL_EVENTS.has(event.type)) {
				throw new Error("Unexpected assistant event from the Cage proxy");
			}
			latest = checkedMessage(event.partial, model);
			if (event.type !== "start" && (!Number.isSafeInteger(event.contentIndex) ||
				(event.contentIndex as number) < 0 || (event.contentIndex as number) >= latest.content.length)) {
				throw new Error("Invalid assistant content index from the Cage proxy");
			}
			started = true;
			output.push(event as unknown as AssistantMessageEvent);
		}

		const task = (async () => {
			try {
				signal.throwIfAborted();
				if (!profile) throw new Error(profileError ?? "Claude Cage is not configured");
				if (model.provider !== PROVIDER_ID || model.api !== API_ID) throw new Error("Invalid Claude Cage model identity");
				// Only the transcript and the four supported stream settings are on the
				// wire. Payload hooks cannot retarget the profile, model, or session.
				const payload = { context: { messages: context.messages }, options: wireOptions(options) };
				const update = options.onPayload ? await withAbort(options.onPayload(payload, model),
					AbortSignal.any([signal, AbortSignal.timeout(10_000)])) : undefined;
				const selected = update === undefined ? payload : update;
				if (!isRecord(selected) || !isRecord(selected.context) || !Array.isArray(selected.context.messages) ||
					!isRecord(selected.options)) throw new Error("Invalid Claude Cage payload replacement");
				const safeOptions = wireOptions(selected.options);
				const final = await requestCage(profile, {
					op: "turn", sessionId, model: publicModel(model),
					context: { messages: selected.context.messages }, options: safeOptions,
				}, {
					signal, onSubmit: () => { submitted = true; }, onEvent: observe,
					responseMs: safeOptions.timeoutMs === undefined ? undefined : safeOptions.timeoutMs + 5_000,
				});
				signal.throwIfAborted();
				if (!isRecord(final)) throw new Error("Invalid terminal event from the Cage proxy");
				if (final.type === "done" && started && (final.reason === "stop" || final.reason === "length" || final.reason === "toolUse")) {
					const message = checkedMessage(final.message, model);
					if (message.stopReason !== final.reason) throw new Error("Mismatched assistant stop reason from the Cage proxy");
					output.push({ type: "done", reason: final.reason, message });
				} else if (final.type === "error" && (final.reason === "error" || final.reason === "aborted")) {
					const message = checkedMessage(final.error, model);
					const detail = typeof message.errorMessage === "string" ? message.errorMessage : "guest turn failed";
					const error = safeFailure(message, detail, final.reason === "aborted");
					output.push({ type: "error", reason: final.reason, error });
				} else {
					throw new Error("Invalid terminal event from the Cage proxy");
				}
			} catch (failure) {
				const reason = signal.aborted ? "aborted" : "error";
				const detail = failure instanceof Error ? failure.message : "request failed";
				output.push({ type: "error", reason, error: safeFailure(latest, detail, signal.aborted) });
			} finally {
				output.end();
			}
		})();
		active.add(task);
		void task.then(() => active.delete(task));
		return output;
	}

	const provider: Provider = {
		id: PROVIDER_ID, name: "Claude Code (Cage)", baseUrl: BASE_URL,
		auth: { apiKey: {
			name: "Guest-local Claude Code login",
			async check() { return profile ? { type: "api_key", source: "Cage profile" } : undefined; },
			async resolve() { return profile ? { auth: {}, source: "Cage profile" } : undefined; },
		} },
		getModels: () => catalog,
		stream, streamSimple: stream,
	};

	return {
		provider,
		setModels(models: Model<Api>[]) { catalog = models; },
		signal: lifecycle.signal,
		shutdown() {
			shutdown ??= (async () => {
				lifecycle.abort();
				await Promise.allSettled(active);
				if (profile && submitted && await requestCage(profile, { op: "close", sessionId }) !== null) {
					throw new Error("Invalid close acknowledgement from the Cage proxy");
				}
			})();
			return shutdown;
		},
	};
}
