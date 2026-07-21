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
