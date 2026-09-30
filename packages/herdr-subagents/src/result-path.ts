import { resolve } from "node:path";

export function resultPathForAttempt(taskDirectory: string, attempt: number): string {
	return attempt > 1
		? resolve(taskDirectory, "turns", `${String(attempt).padStart(2, "0")}-result.md`)
		: resolve(taskDirectory, "result.md");
}
