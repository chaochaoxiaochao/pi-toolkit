import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRunRecord } from "./records.ts";

export async function findRunDirectory(runsDirectory: string, runId: string): Promise<string | undefined> {
	if (!existsSync(runsDirectory)) return undefined;
	const errors: string[] = [];
	for (const entry of readdirSync(runsDirectory)) {
		const directory = join(runsDirectory, entry);
		const runFile = join(directory, "run.json");
		try {
			if ((await readRunRecord(runFile)).id === runId) return directory;
		} catch (error) {
			errors.push(`${runFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (errors.length) throw new Error(`Could not inspect Subagent runs while looking for '${runId}': ${errors.join("; ")}`);
	return undefined;
}
