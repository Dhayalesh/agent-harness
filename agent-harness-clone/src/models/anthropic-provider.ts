import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { AgentHarnessError } from '../core/errors.js';
import type { AgentMessage, MessageContent } from '../core/messages.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent, StopReason } from './provider.js';

export type AnthropicProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  client?: Anthropic;
};

export class AnthropicModelProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-4-6';
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const toolInputs = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = 'end_turn';
    const stream = this.client.messages.stream(
      {
        model: request.model ?? this.defaultModel,
        max_tokens: request.maxOutputTokens ?? 8_192,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools.map((tool): ToolUnion => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as AnthropicTool['input_schema'],
        })),
        ...(request.systemPrompt === undefined ? {} : { system: request.systemPrompt }),
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          yield {
            type: 'usage',
            usage: {
              inputTokens: event.message.usage.input_tokens,
              outputTokens: event.message.usage.output_tokens,
              cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
            },
          };
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolInputs.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: '',
            });
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const pending = toolInputs.get(event.index);
            if (pending) pending.json += event.delta.partial_json;
          }
          break;
        case 'content_block_stop': {
          const pending = toolInputs.get(event.index);
          if (pending) {
            let input: unknown = {};
            try {
              input = pending.json ? JSON.parse(pending.json) : {};
            } catch (cause) {
              throw new AgentHarnessError(
                `Model returned malformed JSON for tool ${pending.name}`,
                'MALFORMED_TOOL_JSON',
                false,
                { cause },
              );
            }
            yield {
              type: 'tool_call',
              id: pending.id,
              name: pending.name,
              input,
            };
            toolInputs.delete(event.index);
          }
          break;
        }
        case 'message_delta':
          stopReason = normalizeStopReason(event.delta.stop_reason);
          yield {
            type: 'usage',
            usage: {
              inputTokens: 0,
              outputTokens: event.usage.output_tokens,
            },
          };
          break;
        case 'message_stop':
          yield { type: 'completed', stopReason };
          break;
      }
    }
  }
}

function toAnthropicMessages(messages: readonly AgentMessage[]): MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: MessageContent): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

function normalizeStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
    case 'model_context_window_exceeded':
    case null:
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
