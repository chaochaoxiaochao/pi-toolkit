import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelIdentity = {
	provider: string;
	api: string;
	id: string;
};

const CACHE_MODEL_PREFIXES = ["gpt-6"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTargetModel(model: ModelIdentity): boolean {
	return model.provider === "openai" &&
		model.api === "openai-responses" &&
		CACHE_MODEL_PREFIXES.some((prefix) =>
		model.id === prefix || model.id.startsWith(`${prefix}-`) || model.id.startsWith(`${prefix}.`));
}

/** Request OpenAI's 12-hour prompt-cache lifetime when long retention is enabled. */
export default function openAICache12h(pi: ExtensionAPI) {
	pi.on("before_provider_request", ({ payload }, ctx) => {
		if (process.env.PI_CACHE_RETENTION !== "long" || !isRecord(payload)) return;
		const model = ctx.model;
		if (!model || !isTargetModel(model)) return;

		const options = payload.prompt_cache_options;
		if (isRecord(options) && options.ttl === "30m") {
			return {
				...payload,
				prompt_cache_options: { ...options, ttl: "12h" },
			};
		}
	});
}
