import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"powershell",
]);

export interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
}

export interface AgentDiscovery {
	agents: AgentDefinition[];
	diagnostics: string[];
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseList(value: string): string[] | undefined {
	let source = value.trim();
	if (!source) return undefined;
	if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1);
	const items = source.split(",").map((item) => unquote(item).trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

export function parseAgentMarkdown(content: string, filePath = "<memory>"): AgentDefinition {
	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") throw new Error("missing YAML frontmatter");

	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) throw new Error("unterminated YAML frontmatter");

	const fields = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (!match) throw new Error(`invalid frontmatter line: ${line}`);
		fields.set(match[1], unquote(match[2]));
	}

	const name = fields.get("name")?.trim();
	const description = fields.get("description")?.trim();
	if (!name) throw new Error("frontmatter name is required");
	if (!description) throw new Error("frontmatter description is required");

	const rawTools = fields.get("tools");
	const tools = rawTools === undefined ? undefined : parseList(rawTools);
	if (rawTools !== undefined && !tools) throw new Error("frontmatter tools must not be empty");
	for (const tool of tools ?? []) {
		if (!BUILTIN_TOOLS.has(tool)) throw new Error(`unsupported non-builtin tool: ${tool}`);
	}

	const model = fields.get("model")?.trim() || undefined;
	return {
		name,
		description,
		...(model ? { model } : {}),
		...(tools ? { tools } : {}),
		systemPrompt: lines.slice(end + 1).join("\n").trim(),
		filePath,
	};
}

export function discoverPackageAgents(agentsDir: string): AgentDiscovery {
	const agents: AgentDefinition[] = [];
	const diagnostics: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(agentsDir).filter((entry) => entry.endsWith(".md")).sort();
	} catch (error) {
		return { agents, diagnostics: [`Cannot read persona directory ${agentsDir}: ${error instanceof Error ? error.message : String(error)}`] };
	}

	const names = new Set<string>();
	for (const entry of entries) {
		const filePath = join(agentsDir, entry);
		try {
			if (!statSync(filePath).isFile()) continue;
			const definition = parseAgentMarkdown(readFileSync(filePath, "utf8"), filePath);
			if (names.has(definition.name)) {
				diagnostics.push(`${filePath}: duplicate persona name '${definition.name}'`);
				continue;
			}
			names.add(definition.name);
			agents.push(definition);
		} catch (error) {
			diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { agents, diagnostics };
}
