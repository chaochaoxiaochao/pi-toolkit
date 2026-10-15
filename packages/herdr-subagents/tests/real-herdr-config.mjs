import { resolve } from "node:path";
import { loadSubagentConfiguration } from "../src/config.ts";

export function smokePersona(cwd, agentsDirectory, model, paths) {
	const discovery = loadSubagentConfiguration(cwd, agentsDirectory, undefined, paths);
	const analyst = discovery.personas.find(({ name }) => name === "analyst");
	if (!analyst) throw new Error("Real Herdr smoke requires an analyst Persona.");
	return {
		model: model?.trim() || analyst.model,
		thinking: analyst.thinking,
		// Local sources must still resolve from the caller's project after moving to the fixture cwd.
		extensions: analyst.extensions.map((source) => /^(?:[a-z][a-z\d+.-]*:|~(?:\/|$)|git@)/i.test(source) ? source : resolve(cwd, source)),
	};
}
