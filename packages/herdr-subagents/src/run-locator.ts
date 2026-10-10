import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readRunRecord } from "./records.ts";

export async function findRunDirectory(runsDirectory: string, runId: string): Promise<string | undefined> {
	if (!existsSync(runsDirectory)) return undefined;
	const reference = basename(runId.trim());
	const errors: string[] = [];
	const matches: Array<{ id: string; directory: string }> = [];
	for (const entry of readdirSync(runsDirectory)) {
		const directory = join(runsDirectory, entry);
		const runFile = join(directory, "run.json");
		try {
			const id = (await readRunRecord(runFile)).id;
			if (id === reference || entry === reference) return directory;
			if (id.startsWith(reference) || entry.endsWith(`-${reference}`)) matches.push({ id, directory });
		} catch (error) {
			errors.push(`${runFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (matches.length === 1) return matches[0].directory;
	if (matches.length > 1) throw new Error(`Ambiguous Subagent run reference '${runId}': ${matches.map((match) => match.id).join(", ")}.`);
	if (errors.length) throw new Error(`Could not inspect Subagent runs while looking for '${runId}': ${errors.join("; ")}`);
	return undefined;
}

export function resolveRunIdReference(reference: string, candidates: readonly string[]): string | undefined {
	const trimmed = basename(reference.trim());
	const exact = candidates.find((candidate) => candidate === trimmed);
	if (exact) return exact;
	const matches = [...new Set(candidates.filter((candidate) => candidate.startsWith(trimmed)))];
	if (matches.length > 1) throw new Error(`Ambiguous Subagent run reference '${reference}': ${matches.join(", ")}.`);
	return matches[0];
}
