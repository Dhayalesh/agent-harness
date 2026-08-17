const MAX_ASSISTANT_TEXT_CHARS = 2_000_000;

/** Retains conversational text even when files are the primary response. */
export function hydrateRuntimeText(result) {
  const output = presentedAssistantText(
    result?.output || assistantTextFromMessages(result?.messages),
  );
  return { ...result, output };
}

/** Combines assistant text blocks produced after the latest user prompt. */
export function assistantTextFromMessages(messages) {
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
    .filter((message) => message?.role === "assistant")
    .flatMap((message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === "text" && block.text)
        .map((block) => block.text.trim()),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function presentedAssistantText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= MAX_ASSISTANT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_ASSISTANT_TEXT_CHARS)}\n\n... response truncated`;
}
