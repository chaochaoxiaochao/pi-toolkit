import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const HerdrSubagentsParams = Type.Object({
	action: Type.Optional(StringEnum(["list", "respond", "history", "resume", "cleanup"] as const, { description: "Operation mode. Omit it to execute one task or a batch." })),
	runId: Type.Optional(Type.String({ minLength: 1, description: "Durable run ID used by respond, resume, or cleanup." })),
	answer: Type.Optional(Type.String({ minLength: 1, description: "Answer sent to a blocked task when action is respond." })),
	task: Type.Optional(Type.Integer({ minimum: 1, description: "One-based task number selected for respond or resume." })),
	prompt: Type.Optional(Type.String({ minLength: 1, description: "Task prompt for single execution, or follow-up prompt for resume." })),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Persona for single execution. Defaults to worker." })),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 48, description: "Short Herdr run-tab label." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Optional Pi model override, for example provider/model:high." })),
	tasks: Type.Optional(Type.Array(Type.Object({
		name: Type.String({ minLength: 1, maxLength: 48, description: "Short task name shown in the pane and task list." }),
		prompt: Type.String({ minLength: 1, description: "Self-contained prompt for this task." }),
		agent: Type.Optional(Type.String({ minLength: 1, description: "Persona for this task. Defaults to worker." })),
		model: Type.Optional(Type.String({ minLength: 1, description: "Optional model override for this task." })),
	}), { minItems: 1, description: "Ordered tasks for bounded-concurrency batch execution." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum simultaneously active Agents in a batch." })),
	background: Type.Optional(Type.Boolean({ description: "Return a run ID immediately while the batch continues in this parent session." })),
}, { additionalProperties: false });
