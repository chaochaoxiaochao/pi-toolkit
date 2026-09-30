import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";

export default function (_pi: ExtensionAPI) {
	let tool: Record<string, any> | undefined;
	const pi = {
		on() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		registerCommand() {},
		sendMessage() {},
	};

	registerHerdrSubagents(pi as never, { herdr: {} as never });
	if (!tool) throw new Error("herdr_subagents was not registered");
	const schema = tool.parameters as Record<string, any>;
	if (schema.type !== "object" || schema.anyOf || schema.oneOf) throw new Error("herdr_subagents parameters must be one flat object schema");
	const required = ["action", "runId", "answer", "task", "prompt", "agent", "label", "model", "tasks", "concurrency", "background"];
	for (const name of required) {
		if (!schema.properties?.[name]) throw new Error(`schema is missing property '${name}'`);
		if (!schema.properties[name].description) throw new Error(`schema property '${name}' has no description`);
	}
	for (const name of ["name", "prompt", "agent", "model"]) {
		const property = schema.properties.tasks.items.properties[name];
		if (!property?.description) throw new Error(`nested task property '${name}' has no description`);
	}
	if (!/Foreground calls block/.test(tool.description) || !/background batches return a run ID immediately/.test(tool.description)) {
		throw new Error("tool description does not distinguish foreground and background execution");
	}
}
