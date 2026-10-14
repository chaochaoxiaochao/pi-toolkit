import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireFileLock } from "../../src/lock.ts";

/**
 * Stand-in for pi's own AuthStorage: one credential per provider, a single-entry merge per
 * write, in-place file writes, and the shared auth.json lock. The ownership checks need pi's
 * real write semantics, not a convenient in-memory store.
 */
export class NativeCredentialStore {
	constructor(authPath) {
		this.authPath = authPath;
	}

	#read() {
		if (!existsSync(this.authPath)) return {};
		const content = readFileSync(this.authPath, "utf8");
		return content.trim() === "" ? {} : JSON.parse(content);
	}

	async #withLock(run) {
		const lock = await acquireFileLock(this.authPath);
		try {
			const data = this.#read();
			const { result, next } = await run(data);
			if (next !== undefined) {
				lock.assertHeld();
				writeFileSync(this.authPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
			}
			return result;
		} finally {
			await lock.release();
		}
	}

	async read(providerId) {
		return this.#read()[providerId];
	}

	async list() {
		return Object.entries(this.#read()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(providerId, fn) {
		return this.#withLock(async (data) => {
			const next = await fn(data[providerId]);
			if (next === undefined) return { result: data[providerId] };
			return { result: next, next: { ...data, [providerId]: next } };
		});
	}

	async delete(providerId) {
		await this.#withLock(async (data) => {
			const next = { ...data };
			delete next[providerId];
			return { result: undefined, next };
		});
	}
}
