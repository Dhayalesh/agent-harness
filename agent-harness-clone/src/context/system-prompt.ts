export type SystemPromptSection = {
  id: string;
  content: string;
  priority?: number;
  enabled?: boolean;
};

export function composeSystemPrompt(sections: readonly SystemPromptSection[]): string {
  return sections
    .filter((section) => section.enabled !== false && section.content.trim())
    .toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .map((section) => section.content.trim())
    .join('\n\n');
}
