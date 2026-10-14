export const CODEX_POOL_SUBCOMMANDS = ["status", "use", "remove", "off"] as const;

export interface CommandCompletion {
	value: string;
	label: string;
}

/**
 * Pi consumes Enter to accept an argument completion. Once a subcommand is exact,
 * hide its identical candidate so Enter submits the slash command immediately.
 */
export function codexPoolArgumentCompletions(prefix: string): CommandCompletion[] {
	const normalized = prefix.trim();
	if (normalized.includes(" ") || CODEX_POOL_SUBCOMMANDS.some((name) => name === normalized)) return [];
	return CODEX_POOL_SUBCOMMANDS
		.filter((name) => name.startsWith(normalized))
		.map((name) => ({ value: name, label: name }));
}
