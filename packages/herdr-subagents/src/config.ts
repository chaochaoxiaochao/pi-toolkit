import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverPackageAgents, type AgentDefinition } from "./personas.ts";

export type PersonaAccess = "read" | "write";
export type SubagentToolExposure = "direct" | "model-only";
export interface PersonaConfig { model?: string; thinking?: string; skills?: string[]; extensions?: string[]; }
export interface SubagentConfig {
	exposure?: SubagentToolExposure;
	defaultConcurrency: number;
	maxConcurrency: number;
	stalledWarningSeconds: number;
	abortGraceSeconds: number;
	defaultModel?: string;
	defaultThinking?: string;
	defaultExtensions?: string[];
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
	extensions: string[];
	extensionsSource: string;
}
export interface SubagentConfiguration {
	settings: SubagentConfig;
	settingSources: Record<string, string>;
	personas: EffectivePersona[];
	diagnostics: string[];
}
interface ConfigFile {
	exposure?: string;
	defaultConcurrency?: number;
	maxConcurrency?: number;
	stalledWarningSeconds?: number;
	abortGraceSeconds?: number;
	defaultModel?: string;
	defaultThinking?: string;
	defaultExtensions?: string[];
	personas?: Record<string, PersonaConfig>;
}
export interface ConfigurationPaths {
	globalConfig?: string;
	projectConfig?: string;
	globalAgents?: string;
	projectAgents?: string;
}
const DEFAULTS: SubagentConfig = { defaultConcurrency: 1, maxConcurrency: 4, stalledWarningSeconds: 300, abortGraceSeconds: 30, personas: {} };

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
	if (input.exposure !== undefined) {
		if (input.exposure === "direct" || input.exposure === "model-only") { result.exposure = input.exposure; sources.exposure = source; }
		else diagnostics.push(`${source} exposure must be 'direct' or 'model-only'`);
	}
	for (const key of ["defaultConcurrency", "maxConcurrency", "stalledWarningSeconds", "abortGraceSeconds"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (!Number.isInteger(value) || Number(value) <= 0) { diagnostics.push(`${source} ${key} must be a positive integer`); continue; }
		result[key] = value as number;
		sources[key] = source;
	}
	for (const key of ["defaultModel", "defaultThinking"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (typeof value === "string" && value.trim()) { result[key] = value.trim(); sources[key] = source; }
		else diagnostics.push(`${source} ${key} must be a non-empty string`);
	}
	if (input.defaultExtensions !== undefined) {
		const value = input.defaultExtensions;
		if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
			result.defaultExtensions = value.map((item) => item.trim());
			sources.defaultExtensions = source;
		} else diagnostics.push(`${source} defaultExtensions must be an array of non-empty strings`);
	}
	if (input.personas !== undefined) {
		if (!input.personas || typeof input.personas !== "object" || Array.isArray(input.personas)) diagnostics.push(`${source} personas must be an object`);
		else for (const [name, raw] of Object.entries(input.personas)) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) { diagnostics.push(`${source} persona '${name}' must be an object`); continue; }
			const valid: PersonaConfig = {};
			for (const field of ["model", "thinking"] as const) {
				const value = raw[field];
				if (value === undefined) continue;
				if (typeof value === "string" && value.trim()) valid[field] = value.trim();
				else diagnostics.push(`${source} persona '${name}' ${field} must be a non-empty string`);
			}
			for (const field of ["skills", "extensions"] as const) {
				const value = raw[field];
				if (value === undefined) continue;
				if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) valid[field] = value.map((item) => item.trim());
				else diagnostics.push(`${source} persona '${name}' ${field} must be an array of non-empty strings`);
			}
			input.personas[name] = valid;
			result.personas[name] = { ...(result.personas[name] ?? {}), ...valid };
			for (const field of Object.keys(valid)) sources[`personas.${name}.${field}`] = source;
		}
	}
	return result;
}

export function loadSubagentConfiguration(cwd: string, packageAgentsDirectory: string, parentModel?: string, paths: ConfigurationPaths = {}): SubagentConfiguration {
	const diagnostics: string[] = [];
	const globalConfigPath = paths.globalConfig ?? join(homedir(), ".pi", "agent", "herdr-subagents.json");
	const projectConfigPath = paths.projectConfig ?? join(cwd, ".pi", "herdr-subagents.json");
	const globalAgentsDirectory = paths.globalAgents ?? join(dirname(globalConfigPath), "herdr-subagents", "agents");
	const projectAgentsDirectory = paths.projectAgents ?? join(cwd, ".pi", "herdr-subagents", "agents");
	const settingSources: Record<string, string> = { defaultConcurrency: "built-in", maxConcurrency: "built-in", stalledWarningSeconds: "built-in", abortGraceSeconds: "built-in" };
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
		const thinking = projectPersona.thinking ?? globalPersona.thinking ?? definition.thinking ?? settings.defaultThinking;
		const thinkingSource = projectPersona.thinking ? "project persona" : globalPersona.thinking ? "global persona" : definition.thinking ? `${source} persona` : settings.defaultThinking ? settingSources.defaultThinking : "default";
		const skills = projectPersona.skills ?? globalPersona.skills ?? definition.skills ?? [];
		const skillsSource = projectPersona.skills ? "project persona" : globalPersona.skills ? "global persona" : definition.skills ? `${source} persona` : "none";
		const extensions = projectPersona.extensions ?? globalPersona.extensions ?? definition.extensions ?? settings.defaultExtensions ?? [];
		const extensionsSource = projectPersona.extensions ? "project persona" : globalPersona.extensions ? "global persona" : definition.extensions ? `${source} persona` : settings.defaultExtensions ? settingSources.defaultExtensions : "none";
		return { ...definition, source, access: definition.access ?? "write", model, modelSource, thinking, thinkingSource, skills, skillsSource, extensions, extensionsSource };
	}).sort((left, right) => left.name.localeCompare(right.name));
	return { settings, settingSources, personas, diagnostics };
}
