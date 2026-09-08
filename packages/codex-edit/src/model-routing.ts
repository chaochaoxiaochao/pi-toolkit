export function globMatches(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function modelIsAllowed(model, settings) {
  if (!settings.enabled || !model) return false;
  if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
  if (model.compat?.supportsOpenAIGrammarTools !== true) return false;
  return (settings.models || []).some((pattern) =>
    typeof pattern === "string" && globMatches(model.id, pattern),
  );
}
