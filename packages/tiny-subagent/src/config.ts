import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverPackageAgents, type AgentDefinition } from "./personas.ts";

export type PersonaAccess = "read" | "write";
export interface PersonaConfig { model?: string; thinking?: string; skills?: string[]; }
export interface SubagentConfig {
	defaultConcurrency: number;
	maxConcurrency: number;
	stalledWarningSeconds: number;
	defaultModel?: string;
	personas: Record<string, PersonaConfig>;
}
export interface EffectivePersona extends AgentDefinition {
	source: "project" | "global" | "package";
	access: PersonaAccess;
	model?: string;
	modelSource: string;
	thinking?: string;
	thinkingSource: string;
	skills: string[];
	skillsSource: string;
}
export interface SubagentConfiguration {
	settings: SubagentConfig;
	settingSources: Record<string, string>;
	personas: EffectivePersona[];
	diagnostics: string[];
}
interface ConfigFile {
	defaultConcurrency?: number;
	maxConcurrency?: number;
	stalledWarningSeconds?: number;
	defaultModel?: string;
	personas?: Record<string, PersonaConfig>;
}
export interface ConfigurationPaths {
	globalConfig?: string;
	projectConfig?: string;
	globalAgents?: string;
	projectAgents?: string;
}
const DEFAULTS: SubagentConfig = { defaultConcurrency: 1, maxConcurrency: 4, stalledWarningSeconds: 300, personas: {} };

function readConfig(path: string, source: string, diagnostics: string[]): ConfigFile {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
		return value as ConfigFile;
	} catch (error) {
		diagnostics.push(`${source} configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function mergeConfig(base: SubagentConfig, input: ConfigFile, source: string, sources: Record<string, string>, diagnostics: string[]): SubagentConfig {
	const result: SubagentConfig = { ...base, personas: { ...base.personas } };
	for (const key of ["defaultConcurrency", "maxConcurrency", "stalledWarningSeconds"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (!Number.isInteger(value) || Number(value) <= 0) { diagnostics.push(`${source} ${key} must be a positive integer`); continue; }
		result[key] = value as number;
		sources[key] = source;
	}
	if (input.defaultModel !== undefined) {
		if (typeof input.defaultModel === "string" && input.defaultModel.trim()) { result.defaultModel = input.defaultModel.trim(); sources.defaultModel = source; }
		else diagnostics.push(`${source} defaultModel must be a non-empty string`);
	}
	if (input.personas !== undefined) {
		if (!input.personas || typeof input.personas !== "object" || Array.isArray(input.personas)) diagnostics.push(`${source} personas must be an object`);
		else for (const [name, raw] of Object.entries(input.personas)) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) { diagnostics.push(`${source} persona '${name}' must be an object`); continue; }
			result.personas[name] = { ...(result.personas[name] ?? {}), ...raw };
			for (const field of Object.keys(raw)) sources[`personas.${name}.${field}`] = source;
		}
	}
	return result;
}

export function loadSubagentConfiguration(cwd: string, packageAgentsDirectory: string, parentModel?: string, paths: ConfigurationPaths = {}): SubagentConfiguration {
	const diagnostics: string[] = [];
	const globalConfigPath = paths.globalConfig ?? join(homedir(), ".pi", "agent", "subagents.json");
	const projectConfigPath = paths.projectConfig ?? join(cwd, ".pi", "subagents.json");
	const globalAgentsDirectory = paths.globalAgents ?? join(dirname(globalConfigPath), "subagents", "agents");
	const projectAgentsDirectory = paths.projectAgents ?? join(cwd, ".pi", "subagents", "agents");
	const settingSources: Record<string, string> = { defaultConcurrency: "built-in", maxConcurrency: "built-in", stalledWarningSeconds: "built-in" };
	const globalInput = readConfig(globalConfigPath, "global", diagnostics);
	const projectInput = readConfig(projectConfigPath, "project", diagnostics);
	const globalSettings = mergeConfig(DEFAULTS, globalInput, "global", settingSources, diagnostics);
	const settings = mergeConfig(globalSettings, projectInput, "project", settingSources, diagnostics);
	if (settings.defaultConcurrency > settings.maxConcurrency) { diagnostics.push("defaultConcurrency exceeds maxConcurrency; maxConcurrency is used"); settings.defaultConcurrency = settings.maxConcurrency; }
	const layers = [
		{ source: "package" as const, discovery: discoverPackageAgents(packageAgentsDirectory) },
		{ source: "global" as const, discovery: discoverPackageAgents(globalAgentsDirectory, true) },
		{ source: "project" as const, discovery: discoverPackageAgents(projectAgentsDirectory, true) },
	];
	const definitions = new Map<string, { definition: AgentDefinition; source: "project" | "global" | "package" }>();
	for (const layer of layers) { diagnostics.push(...layer.discovery.diagnostics); for (const definition of layer.discovery.agents) definitions.set(definition.name, { definition, source: layer.source }); }
	const personas = [...definitions.values()].map(({ definition, source }): EffectivePersona => {
		const globalPersona = globalInput.personas?.[definition.name] ?? {};
		const projectPersona = projectInput.personas?.[definition.name] ?? {};
		const model = projectPersona.model ?? globalPersona.model ?? definition.model ?? settings.defaultModel ?? parentModel;
		const modelSource = projectPersona.model ? "project persona" : globalPersona.model ? "global persona" : definition.model ? `${source} persona` : settings.defaultModel ? settingSources.defaultModel : parentModel ? "parent session" : "unresolved";
		const thinking = projectPersona.thinking ?? globalPersona.thinking ?? definition.thinking;
		const thinkingSource = projectPersona.thinking ? "project persona" : globalPersona.thinking ? "global persona" : definition.thinking ? `${source} persona` : "default";
		const skills = projectPersona.skills ?? globalPersona.skills ?? definition.skills ?? [];
		const skillsSource = projectPersona.skills ? "project persona" : globalPersona.skills ? "global persona" : definition.skills ? `${source} persona` : "none";
		return { ...definition, source, access: definition.access ?? "write", model, modelSource, thinking, thinkingSource, skills, skillsSource };
	}).sort((left, right) => left.name.localeCompare(right.name));
	return { settings, settingSources, personas, diagnostics };
}
