const MAX_REASONING_CHARS = 100_000;

/** Adds the provider-exposed reasoning for the current user turn. */
export function hydrateRuntimeReasoning(result) {
  const fromMessages = reasoningFromMessages(result?.messages);
  const reasoning = presentedReasoning(fromMessages || result?.reasoning);
  return reasoning ? { ...result, reasoning } : { ...result };
}

/** Combines reasoning from every model pass after the latest user prompt. */
export function reasoningFromMessages(messages) {
  const all = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (
      all[index]?.role === "user" &&
      (all[index]?.content ?? []).some((block) => block?.type === "text")
    ) {
      start = index;
      break;
    }
  }

  return all
    .slice(start)
    .filter(
      (message) =>
        message?.role === "assistant" &&
        typeof message.reasoning === "string" &&
        message.reasoning.trim(),
    )
    .map((message) => message.reasoning.trim())
    .join("\n\n");
}

export function presentedReasoning(value) {
  if (typeof value !== "string") return "";
  const reasoning = value.trim();
  if (reasoning.length <= MAX_REASONING_CHARS) return reasoning;
  return `${reasoning.slice(0, MAX_REASONING_CHARS)}\n\n... thinking truncated`;
}
