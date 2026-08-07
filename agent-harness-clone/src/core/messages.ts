export type TextBlock = {
  type: 'text';
  text: string;
};

export type ToolCallBlock = {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
};

export type MessageContent = TextBlock | ToolCallBlock | ToolResultBlock;

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: MessageContent[];
  createdAt: string;
  /**
   * The deliberation behind this message, when the model emitted any.
   *
   * Deliberately beside `content` rather than a block within it: the wire format
   * is built from `content`, so keeping it out here is what stops a past turn's
   * thinking from being replayed to the model as if it were the answer.
   */
  reasoning?: string;
};

export type AgentInput = {
  prompt: string;
  metadata?: Record<string, unknown>;
};

export function textMessage(
  id: string,
  role: AgentMessage['role'],
  text: string,
  createdAt: string,
): AgentMessage {
  return { id, role, createdAt, content: [{ type: 'text', text }] };
}
