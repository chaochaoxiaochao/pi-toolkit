import { setTimeout as delay } from "node:timers/promises";

/** Wait for an observable condition, not an assumed completion time. */
export async function waitFor(check, description, timeoutMs = 5_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const result = await check();
		if (result) return result;
		if (performance.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
		await delay(10);
	}
}
