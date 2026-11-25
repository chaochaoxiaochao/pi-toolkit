import {
	createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError,
	type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type Provider,
	type SimpleStreamOptions, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { TURN_TIMEOUT_MS, createAssistantEventAssembler } from "../guest/protocol.mjs";
import type { CageProfile } from "./profile.ts";
import {
	createCageConnection, isFatalConnectionError, isRecord, withAbort,
	type CageRequest, type RequestOptions,
} from "./transport.ts";

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

function validPromptCache(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const { short, long } = value;
	return (short === undefined || positiveInteger(short)) &&
		(long === undefined || positiveInteger(long)) &&
		(short !== undefined || long !== undefined);
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

function initialWireOptions(options: StreamOptions & { reasoning?: unknown }): WireOptions {
	const safe = wireOptions(options);
	if (safe.cacheRetention === undefined) {
		const configured = options.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION;
		safe.cacheRetention = configured === "long" ? "long" : "short";
	}
	return safe;
}

function publicModel(model: Model<Api>): Model<Api> {
	const { id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap } = model;
	const { input: inCost, output, cacheRead, cacheWrite, tiers } = model.cost;
	const forceAdaptiveThinking = model.compat?.forceAdaptiveThinking === true;
	// The pinned adapter writes explicit one-hour breakpoints. Claude Code's
	// 5m setting does not shorten those markers, so advertising `short` would
	// make Pi refresh a one-hour cache every 4.5 minutes.
	const promptCache = forceAdaptiveThinking && positiveInteger(model.promptCache?.long)
		? { long: model.promptCache.long }
		: undefined;
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
		...(promptCache ? { promptCache } : {}),
		...(forceAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
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
				!model.cost.tiers.every((tier: unknown) => validCosts(tier) && nonNegative(tier.inputTokensAbove)))) ||
			(model.promptCache !== undefined && !validPromptCache(model.promptCache)) ||
			(model.compat !== undefined && (!isRecord(model.compat) ||
				(model.compat.forceAdaptiveThinking !== undefined &&
					typeof model.compat.forceAdaptiveThinking !== "boolean")))) {
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
	if (isFatalConnectionError(detail)) {
		result.errorMessage = detail;
		return result;
	}
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
	const lifecycle = new AbortController();
	const active = new Set<Promise<void>>();
	let priorityOperations = 0;
	let activeWarm: { controller: AbortController; settled: Promise<void> } | undefined;
	let setupPriority = false;
	let shutdown: Promise<void> | undefined;
	const connection = profile ? createCageConnection(profile) : undefined;
	const preemptWarm = async (reason: string) => {
		while (activeWarm) {
			const operation = activeWarm;
			operation.controller.abort(new Error(reason));
			await operation.settled;
			if (activeWarm === operation) activeWarm = undefined;
		}
	};

	function stream(model: Model<Api>, context: TranscriptContext, options: StreamOptions & { reasoning?: unknown } = {}) {
		const output = createAssistantMessageEventStream();
		const warming = options.disableContinuation === true;
		const warmController = warming ? new AbortController() : undefined;
		const previousWarm = activeWarm;
		if (warming) {
			previousWarm?.controller.abort(new Error("Replaced by a newer Claude Cage cache refresh"));
			if (priorityOperations > 0) warmController!.abort(new Error("Skipped while a higher-priority Claude Cage operation is active"));
		} else {
			priorityOperations++;
			previousWarm?.controller.abort(new Error("Preempted by a real Claude Cage turn"));
		}
		const signals = [lifecycle.signal];
		if (options.signal) signals.push(options.signal);
		if (warmController) signals.push(warmController.signal);
		const signal = signals.length === 1 ? lifecycle.signal : AbortSignal.any(signals);
		let latest = newMessage(model);
		let started = false;
		const assembler = createAssistantEventAssembler();
		let terminal: Record<string, unknown> | undefined;

		async function observe(wire: Record<string, unknown>) {
			const event = assembler.accept(wire) as Record<string, unknown>;
			await options.onProviderStreamEvent?.(event, model);
			signal.throwIfAborted();
			if (event.type === "done" || event.type === "error") {
				terminal = event;
				return;
			}
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
				if (previousWarm) await previousWarm.settled;
				signal.throwIfAborted();
				if (!profile) throw new Error(profileError ?? "Claude Cage is not configured");
				if (!connection) throw new Error("Claude Cage connection is unavailable");
				if (model.provider !== PROVIDER_ID || model.api !== API_ID) throw new Error("Invalid Claude Cage model identity");
				// Only the transcript and the four supported stream settings are on the
				// wire. Payload hooks cannot retarget the profile, model, or session.
				const payload = { context: { messages: context.messages }, options: initialWireOptions(options) };
				const update = options.onPayload ? await withAbort(options.onPayload(payload, model),
					AbortSignal.any([signal, AbortSignal.timeout(10_000)])) : undefined;
				const selected = update === undefined ? payload : update;
				if (!isRecord(selected) || !isRecord(selected.context) || !Array.isArray(selected.context.messages) ||
					!isRecord(selected.options)) throw new Error("Invalid Claude Cage payload replacement");
				const safeOptions = wireOptions(selected.options);
				await connection.request({
					op: "turn", model: publicModel(model),
					context: { messages: selected.context.messages }, options: safeOptions,
				}, {
					signal, onEvent: observe,
				});
				signal.throwIfAborted();
				const final = terminal;
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
				if (!warming) priorityOperations--;
				output.end();
			}
		})();
		if (warmController) {
			const operation = { controller: warmController, settled: task };
			activeWarm = operation;
			void task.finally(() => {
				if (activeWarm === operation) activeWarm = undefined;
			});
		}
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
		async request(request: CageRequest, options?: RequestOptions) {
			if (!connection) return Promise.reject(new Error(profileError ?? "Claude Cage is not configured"));
			priorityOperations++;
			try {
				await preemptWarm("Preempted by a Claude Cage control request");
				options?.signal?.throwIfAborted();
				return await connection.request(request, options);
			} finally {
				priorityOperations--;
			}
		},
		async beginSetup() {
			if (!connection) return Promise.reject(new Error(profileError ?? "Claude Cage is not configured"));
			if (setupPriority) throw new Error("Claude Cage setup is already in progress");
			priorityOperations++;
			try {
				await preemptWarm("Preempted by Claude Cage setup");
				await connection.beginSetup();
				setupPriority = true;
			} catch (error) {
				priorityOperations--;
				throw error;
			}
		},
		finishSetup() {
			connection?.finishSetup();
			if (setupPriority) {
				setupPriority = false;
				priorityOperations--;
			}
		},
		get connectionState() { return connection?.state ?? "unavailable"; },
		signal: lifecycle.signal,
		shutdown() {
			shutdown ??= (async () => {
				lifecycle.abort();
				await Promise.allSettled(active);
				await connection?.shutdown();
			})();
			return shutdown;
		},
	};
}
