import assert from "node:assert/strict";
import openAICache12h from "../index.ts";

let handler;
openAICache12h({
	on(event, registered) {
		assert.equal(event, "before_provider_request");
		handler = registered;
	},
});
assert.equal(typeof handler, "function");

const originalRetention = process.env.PI_CACHE_RETENTION;
const context = (provider, api, id) => ({ model: { provider, api, id } });
const openAI = (id) => context("openai", "openai-responses", id);
const codex = (id) => context("openai-codex", "openai-codex-responses", id);

try {
	delete process.env.PI_CACHE_RETENTION;
	assert.equal(handler({
		payload: { model: "gpt-6", prompt_cache_options: { ttl: "30m" } },
	}, openAI("gpt-6")), undefined);
	process.env.PI_CACHE_RETENTION = "short";
	assert.equal(handler({
		payload: { model: "gpt-6", prompt_cache_options: { ttl: "30m" } },
	}, openAI("gpt-6")), undefined);
	process.env.PI_CACHE_RETENTION = "none";
	assert.equal(handler({
		payload: { model: "gpt-6", prompt_cache_options: { ttl: "30m" } },
	}, openAI("gpt-6")), undefined);

	process.env.PI_CACHE_RETENTION = "long";
	for (const id of ["gpt-6", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-sol"]) {
		const payload = {
			model: id,
			prompt_cache_options: { mode: "implicit", ttl: "30m" },
		};
		const result = handler({ payload }, openAI(id));
		assert.deepEqual(result, {
			model: id,
			prompt_cache_options: { mode: "implicit", ttl: "12h" },
		});
		assert.deepEqual(payload, {
			model: id,
			prompt_cache_options: { mode: "implicit", ttl: "30m" },
		});
		assert.equal(handler({ payload: result }, openAI(id)), undefined);
	}

	for (const id of ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6o", "gpt-image-2", "o3"]) {
		assert.equal(handler({
			payload: { model: id, prompt_cache_options: { ttl: "30m" } },
		}, openAI(id)), undefined);
	}
	for (const id of ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6", "gpt-6.1-sol", "gpt-6o", "gpt-image-2", "o3"]) {
		assert.equal(handler({
			payload: { model: id, prompt_cache_key: "session-1" },
		}, codex(id)), undefined);
	}
	for (const promptCacheOptions of [undefined, { mode: "explicit" }, { ttl: "1h" }]) {
		assert.equal(handler({
			payload: {
				model: "gpt-6",
				...(promptCacheOptions ? { prompt_cache_options: promptCacheOptions } : {}),
			},
		}, openAI("gpt-6")), undefined);
	}
	assert.equal(handler({
		payload: {
			model: "gpt-6-sol",
			prompt_cache_key: "session-1",
			prompt_cache_options: { ttl: "30m" },
		},
	}, codex("gpt-6-sol")), undefined);
	assert.equal(handler({
		payload: { model: "gpt-6-sol", prompt_cache_key: "session-1" },
	}, context("openai-codex", "openai-responses", "gpt-6-sol")), undefined);
	assert.equal(handler({
		payload: { model: "gpt-6", prompt_cache_options: { ttl: "30m" } },
	}, context("openai", "openai-completions", "gpt-6")), undefined);
	assert.equal(handler({
		payload: { model: "claude-opus-4-8", prompt_cache_options: { ttl: "30m" } },
	}, context("claude-cage", "claude-cage", "claude-opus-4-8")), undefined);

	for (const payload of [null, [], "request", {}]) {
		assert.equal(handler({ payload }, { model: undefined }), undefined);
	}

	console.log("OpenAI 12-hour cache policy tests passed");
} finally {
	if (originalRetention === undefined) delete process.env.PI_CACHE_RETENTION;
	else process.env.PI_CACHE_RETENTION = originalRetention;
}
