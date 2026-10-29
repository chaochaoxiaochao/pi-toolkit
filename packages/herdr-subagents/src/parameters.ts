import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const HerdrSubagentsTaskParams = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 48, description: "Short task name shown in the pane and task list." }),
	prompt: Type.String({ minLength: 1, description: "Self-contained prompt for this task." }),
	agent: Type.String({ minLength: 1, description: "Persona name, use control list for available Personas." }),
	model: Type.Optional(Type.String({ minLength: 1, description: "User-requested model override; otherwise omit." })),
	thinking: Type.Optional(Type.String({ minLength: 1, description: "User-requested thinking-level override; otherwise omit." })),
}, { additionalProperties: false });

export const HerdrSubagentsParams = Type.Object({
	tasks: Type.Array(HerdrSubagentsTaskParams, { minItems: 1, description: "Ordered tasks to execute. Use one item for a single task; independent read-only tasks may run concurrently." }),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 48, description: "Short Herdr run-tab label." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum active Agents. Values above 1 require read-only Personas; write-capable Personas require 1 or the batch is rejected." })),
}, { additionalProperties: false });

export const HerdrSubagentsControlParams = Type.Object({
	action: StringEnum(["list", "status", "history", "cancel", "cleanup"] as const, { description: "Control operation to perform." }),
	runId: Type.Optional(Type.String({ minLength: 1, description: "Durable run ID used by status, cancel, or cleanup." })),
}, { additionalProperties: false });
