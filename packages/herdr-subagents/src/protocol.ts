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
		"Use status=needs-input with question when missing information prevents progress, or status=failed with an error when the task cannot be completed.",
	].filter((line, index) => line || index > 1).join("\n").trim();
}

export function continuationSystemPrompt(originalPrompt: string | undefined, instruction: string, kind: Exclude<ReportPromptKind, "initial">): string {
	if (!originalPrompt?.trim()) return reportProtocolPrompt(instruction, kind);
	return [TURN_INTRO[kind], originalPrompt.trim(), "", instruction.trim()].join("\n").trim();
}
