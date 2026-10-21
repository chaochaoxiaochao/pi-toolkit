export type ReportPromptKind = "initial" | "resumed" | "followup"; // legacy kinds remain readable

const TURN_INTRO: Record<ReportPromptKind, string> = {
	initial: "",
	resumed: "This is a resumed turn.",
	followup: "This is a new turn in the same logical task.",
};

export function reportProtocolPrompt(systemPrompt: string, kind: ReportPromptKind = "initial"): string {
	return [
		TURN_INTRO[kind],
		systemPrompt.trim(),
		"",
		"Submit your final answer by calling the subagent_report tool.",
		"Put the complete final answer in result, a concise parent-facing paragraph in summary, and list any useful document paths.",
		"Use status=completed when the task is finished, or status=failed with error when it cannot be completed.",
		"Do not pause for parent input; make a reasonable assumption or report failed with the missing requirement.",
	].filter((line, index) => line || index > 1).join("\n").trim();
}

export function continuationSystemPrompt(originalPrompt: string | undefined, instruction: string, kind: Exclude<ReportPromptKind, "initial">): string {
	if (!originalPrompt?.trim()) return reportProtocolPrompt(instruction, kind);
	return [TURN_INTRO[kind], originalPrompt.trim(), "", instruction.trim()].join("\n").trim();
}
