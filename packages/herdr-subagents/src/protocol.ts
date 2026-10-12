export type ReportPromptKind = "initial" | "resumed" | "followup";

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
		"When this turn is finished, call subagent_report exactly once for this turn.",
		"Put the complete final answer in result, a concise parent-facing paragraph in summary, and list any useful document paths.",
		"Use status=completed when the task is finished.",
		"Use status=blocked with question when you have a specific question or decision the parent agent must answer before you can continue; the run stays open waiting for it.",
		"Use status=failed with error when this task cannot be completed, so the run does not wait for an answer.",
	].filter((line, index) => line || index > 1).join("\n").trim();
}

export function continuationSystemPrompt(originalPrompt: string | undefined, instruction: string, kind: Exclude<ReportPromptKind, "initial">): string {
	if (!originalPrompt?.trim()) return reportProtocolPrompt(instruction, kind);
	return [TURN_INTRO[kind], originalPrompt.trim(), "", instruction.trim()].join("\n").trim();
}
