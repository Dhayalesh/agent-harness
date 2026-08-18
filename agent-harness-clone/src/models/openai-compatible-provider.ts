import { AgentAbortError, AgentHarnessError } from '../core/errors.js';
import type { AgentMessage } from '../core/messages.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent, StopReason } from './provider.js';

export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  name?: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  /**
   * Output-limit field name. OpenAI-style gateways expect
   * `max_completion_tokens`; OpenRouter normalizes on `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Gateway-specific request fields merged into the JSON body. */
  extraBody?: Readonly<Record<string, unknown>>;
  /**
   * Which delta field carries the model's deliberation. There is no standard:
   * OpenRouter sends `reasoning`, DeepSeek and the vLLM-family gateways send
   * `reasoning_content`. Unset reads both, which is safe because a response
   * carries at most one of them.
   */
  reasoningField?: string;
  /**
   * Ask for reasoning in the request. Off by default: a gateway that does not
   * know the parameter may reject the call, and one that does may bill for
   * tokens the caller never asked to see.
   */
  requestReasoning?: boolean;
  fetch?: typeof fetch;
};

/** The delta fields read for deliberation when none is configured. */
const REASONING_FIELDS = ['reasoning', 'reasoning_content'] as const;

/**
 * The multimodal form of a user message.
 *
 * Only used when a turn actually carries an image: a plain string is what every
 * gateway accepts, and some older ones reject the array form outright, so the
 * simple shape stays the default.
 */
type CompatibleContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type CompatibleMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | CompatibleContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
};

/**
 * `reasoning` is a string on most gateways and an object on a few that wrap it
 * with metadata. Only the text is forwarded; anything else is ignored rather than
 * stringified into the stream as `[object Object]`.
 */
function reasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (record && typeof record.text === 'string') return record.text;
  if (record && typeof record.content === 'string') return record.content;
  return '';
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly name: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI-compatible provider requires an API key');
    if (!options.defaultModel.trim()) {
      throw new Error('OpenAI-compatible provider requires a default model');
    }
    this.name = options.name ?? 'openai-compatible';
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.signal.aborted) throw new AgentAbortError();
    const response = await this.fetchImplementation(
      `${this.options.baseURL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: request.signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          ...this.options.defaultHeaders,
        },
        body: JSON.stringify({
          model: request.model ?? this.options.defaultModel,
          messages: toCompatibleMessages(request.messages, request.systemPrompt),
          // Some upstream vendors reject an empty `tools` array.
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          // Both spellings, because the gateways that accept one ignore the other.
          ...(this.options.requestReasoning ? { reasoning: {}, include_reasoning: true } : {}),
          ...(request.maxOutputTokens === undefined
            ? {}
            : {
                [this.options.maxTokensField ?? 'max_completion_tokens']: request.maxOutputTokens,
              }),
          ...this.options.extraBody,
        }),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 4_000);
      throw Object.assign(
        new AgentHarnessError(
          `Model API request failed (${response.status}): ${detail || response.statusText}`,
          'MODEL_API_ERROR',
          response.status === 408 ||
            response.status === 409 ||
            response.status === 429 ||
            response.status >= 500,
        ),
        { status: response.status },
      );
    }
    if (!response.body)
      throw new AgentHarnessError('Model API returned no stream', 'EMPTY_MODEL_STREAM');

    const pending = new Map<number, PendingToolCall>();
    let completed = false;
    for await (const payload of readSse(response.body, request.signal)) {
      if (payload === '[DONE]') break;
      const chunk = parseChunk(payload);
      if ('error' in chunk && chunk.error) {
        throw new AgentHarnessError(formatApiError(chunk.error), 'MODEL_STREAM_ERROR');
      }
      const usage = asRecord(chunk.usage);
      if (usage) {
        const outputDetails = asRecord(usage.completion_tokens_details);
        const reasoningTokens = outputDetails?.reasoning_tokens;
        yield {
          type: 'usage',
          usage: {
            inputTokens: numberValue(usage.prompt_tokens),
            outputTokens: numberValue(usage.completion_tokens),
            ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
            ...(typeof usage.cost === 'number' ? { estimatedCostUsd: usage.cost } : {}),
          },
        };
      }
      for (const choiceValue of arrayValue(chunk.choices)) {
        const choice = asRecord(choiceValue);
        if (!choice) continue;
        const delta = asRecord(choice.delta);
        if (delta && typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', delta: delta.content };
        }
        if (delta) {
          const fields = this.options.reasoningField
            ? [this.options.reasoningField]
            : REASONING_FIELDS;
          for (const field of fields) {
            const reasoning = reasoningText(delta[field]);
            if (reasoning) yield { type: 'reasoning_delta', delta: reasoning };
          }
        }
        for (const callValue of arrayValue(delta?.tool_calls)) {
          const call = asRecord(callValue);
          if (!call) continue;
          const index = numberValue(call.index);
          const details = asRecord(call.function);
          const current = pending.get(index) ?? {
            id: '',
            name: '',
            arguments: '',
            emitted: false,
          };
          if (typeof call.id === 'string') current.id += call.id;
          if (typeof details?.name === 'string') current.name += details.name;
          const argumentsDelta = typeof details?.arguments === 'string' ? details.arguments : '';
          current.arguments += argumentsDelta;
          pending.set(index, current);
          // Emitted per chunk as well as assembled at the end: a caller watching a
          // stream can show the tool and its arguments as they arrive instead of
          // waiting for a call that may take seconds to finish spelling itself out.
          yield {
            type: 'tool_call_delta',
            index,
            id: current.id,
            name: current.name,
            argumentsDelta,
          };
        }
        if (!completed && choice.finish_reason !== null && choice.finish_reason !== undefined) {
          yield* emitPendingToolCalls(pending);
          yield { type: 'completed', stopReason: normalizeFinishReason(choice.finish_reason) };
          completed = true;
        }
      }
    }
    if (!completed) {
      const emitted = [...emitPendingToolCalls(pending)];
      for (const event of emitted) yield event;
      yield { type: 'completed', stopReason: emitted.length ? 'tool_use' : 'end_turn' };
    }
  }
}

function toCompatibleMessages(
  messages: readonly AgentMessage[],
  systemPrompt?: string,
): CompatibleMessage[] {
  const compatible: CompatibleMessage[] = [];
  if (systemPrompt) compatible.push({ role: 'system', content: systemPrompt });
  for (const message of messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const toolCalls = message.content.filter((block) => block.type === 'tool_call');
    const toolResults = message.content.filter((block) => block.type === 'tool_result');
    const images = message.content.filter((block) => block.type === 'image');
    if (message.role === 'assistant') {
      compatible.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
      continue;
    }
    if (images.length) {
      compatible.push({
        role: 'user',
        content: [
          ...images.map((image) => ({
            type: 'image_url' as const,
            // Inline data URL rather than a link: the gateway is never handed
            // something to fetch, so a private upload stays private.
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ],
      });
    } else if (text) {
      compatible.push({ role: 'user', content: text });
    }
    for (const result of toolResults) {
      compatible.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
    }
  }
  return compatible;
}

function* emitPendingToolCalls(pending: Map<number, PendingToolCall>): Generator<ModelStreamEvent> {
  for (const [, call] of [...pending.entries()].sort(([left], [right]) => left - right)) {
    if (call.emitted) continue;
    if (!call.id || !call.name) {
      throw new AgentHarnessError('Model returned an incomplete tool call', 'MALFORMED_TOOL_CALL');
    }
    let input: unknown = {};
    try {
      input = call.arguments ? JSON.parse(call.arguments) : {};
    } catch (cause) {
      throw new AgentHarnessError(
        `Model returned malformed JSON for tool ${call.name}`,
        'MALFORMED_TOOL_JSON',
        false,
        { cause },
      );
    }
    call.emitted = true;
    yield { type: 'tool_call', id: call.id, name: call.name, input };
  }
}

async function* readSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw new AgentAbortError();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) {
        const data = buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new AgentHarnessError(
      'Model returned malformed SSE JSON',
      'MALFORMED_MODEL_STREAM',
      false,
      {
        cause,
      },
    );
  }
}

function normalizeFinishReason(value: unknown): StopReason {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length' || value === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function formatApiError(value: unknown): string {
  const error = asRecord(value);
  return typeof error?.message === 'string' ? error.message : JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
