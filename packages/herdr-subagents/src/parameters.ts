import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const HerdrSubagentsTaskParams = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 48, description: "Short task name shown in the pane and task list." }),
	prompt: Type.String({ minLength: 1, description: "Self-contained prompt for this task." }),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Persona for this task. Defaults to worker." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Optional model override for this task." })),
}, { additionalProperties: false });

export const HerdrSubagentsParams = Type.Object({
	tasks: Type.Array(HerdrSubagentsTaskParams, { minItems: 1, description: "Ordered tasks to execute. Use one item for a single task; independent read-only tasks may run concurrently." }),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 48, description: "Short Herdr run-tab label." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum simultaneously active Agents. Write-capable tasks force concurrency one." })),
	background: Type.Optional(Type.Boolean({ description: "Return a run ID immediately while the run continues in this parent session." })),
}, { additionalProperties: false });

export const HerdrSubagentsControlParams = Type.Object({
	action: StringEnum(["list", "respond", "history", "resume", "cleanup"] as const, { description: "Control operation to perform." }),
	runId: Type.Optional(Type.String({ minLength: 1, description: "Durable run ID used by respond, resume, or cleanup." })),
	answer: Type.Optional(Type.String({ minLength: 1, description: "Answer sent to a blocked task when action is respond." })),
	task: Type.Optional(Type.Integer({ minimum: 1, description: "One-based task number selected for respond or resume." })),
	prompt: Type.Optional(Type.String({ minLength: 1, description: "Follow-up prompt used by resume." })),
}, { additionalProperties: false });
