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

/**
 * An image supplied with a user turn.
 *
 * Bytes rather than a URL: the model gateway is not given anything to fetch, so a
 * caller's private upload never has to be publicly reachable for a model to read
 * it. `data` is base64 without a data-URL prefix; the provider adds whatever
 * envelope its wire format wants.
 *
 * Only ever produced by a caller's attachments — the harness does not generate
 * these, and the model cannot return one.
 */
export type ImageBlock = {
  type: 'image';
  /** An image media type the provider accepts, such as `image/png`. */
  mediaType: string;
  /** Base64-encoded bytes, with no `data:` prefix. */
  data: string;
  /** Shown to the model so it can refer to the file by name. */
  filename?: string;
};

export type MessageContent = TextBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

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
  /**
   * Images to send with this turn. Text attachments are not listed here: a caller
   * folds their extracted content into `prompt`, because every model reads text
   * and only some read images.
   */
  images?: readonly ImageBlock[];
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

/**
 * A user turn that may carry images.
 *
 * Images lead and the text follows, which is the order every provider documents
 * for "here is a picture, now my question about it".
 */
export function userMessage(
  id: string,
  text: string,
  createdAt: string,
  images: readonly ImageBlock[] = [],
): AgentMessage {
  return {
    id,
    role: 'user',
    createdAt,
    content: [...images, { type: 'text', text }],
  };
}
