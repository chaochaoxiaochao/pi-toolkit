import { resolve } from "node:path";
import { loadSubagentConfiguration } from "../src/config.ts";

export function smokePersona(cwd, agentsDirectory, model, paths) {
	const discovery = loadSubagentConfiguration(cwd, agentsDirectory, undefined, paths);
	const reviewer = discovery.personas.find(({ name }) => name === "reviewer");
	if (!reviewer) throw new Error("Real Herdr smoke requires a reviewer Persona.");
	return {
		model: model?.trim() || reviewer.model,
		thinking: reviewer.thinking,
		// Local sources must still resolve from the caller's project after moving to the fixture cwd.
		extensions: reviewer.extensions.map((source) => /^(?:[a-z][a-z\d+.-]*:|~(?:\/|$)|git@)/i.test(source) ? source : resolve(cwd, source)),
	};
}
