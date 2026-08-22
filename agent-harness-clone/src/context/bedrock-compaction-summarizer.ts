import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  CompactionSummaryInput,
  CompactionSummaryResult,
  CompactionSummarizer,
} from './context-manager.js';
import type { AgentMessage } from '../core/messages.js';

export type BedrockCompactionSummarizerOptions = {
  /** Bedrock model ID, e.g. `anthropic.claude-sonnet-5`. */
  modelId: string;
  /** AWS region. Defaults to `AWS_REGION` env var or `us-east-1`. */
  region?: string;
  /**
   * Bedrock runtime endpoint URL.
   * Standard:  https://bedrock-runtime.<region>.amazonaws.com
   * AgentCore/Mantle: the Mantle-injected endpoint from COMPACTION_MODEL_ENDPOINT.
   * When omitted the SDK resolves the default endpoint for the region.
   */
  endpoint?: string;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /** Maximum tokens to generate in the summary. Default: 2 000. */
  maxSummaryTokens?: number;
};

/**
 * Compaction summarizer backed by Amazon Bedrock's Converse API.
 *
 * Uses the model configured via `COMPACTION_MODEL` (default:
 * `anthropic.claude-sonnet-5`) to produce a Pi-style structured summary of
 * older conversation history before it is compacted out of the model context.
 *
 * On any failure the caller falls back to deterministic compaction — this class
 * must never throw; it returns `undefined` on error.
 */
export class BedrockCompactionSummarizer implements CompactionSummarizer {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly maxSummaryTokens: number;

  constructor(options: BedrockCompactionSummarizerOptions) {
    this.modelId = options.modelId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxSummaryTokens = options.maxSummaryTokens ?? 2_000;
    this.client = new BedrockRuntimeClient({
      region: options.region ?? process.env.AWS_REGION ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      requestHandler: {
        requestTimeout: this.timeoutMs,
        httpsAgent: undefined,
      } as unknown as BedrockRuntimeClient['config']['requestHandler'],
    });
  }

  async summarize(input: CompactionSummaryInput): Promise<CompactionSummaryResult | undefined> {
    try {
      const conversationText = renderMessagesForSummarization(input.messages);
      const systemPrompt = COMPACTION_SYSTEM_PROMPT;
      const userContent = [
        // The deterministic reading of the conversation's state, when the caller
        // derived one. Given first and named as already-verified, so the model
        // corroborates and extends it rather than rediscovering it — a summariser
        // starting from scratch is a summariser that can lose the one constraint the
        // whole task depended on.
        input.stateOutline === undefined || input.stateOutline.trim() === ''
          ? undefined
          : `The following state has already been extracted from this conversation and is known to be accurate. Preserve every line of it, and add anything else of importance you find:\n\n${input.stateOutline}`,
        `Here is the conversation history to summarize:\n\n${conversationText}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join('\n\n---\n\n');

      // The caller's allowance wins when it is the smaller of the two. A summariser
      // that writes to its own configured ceiling is spending a budget it cannot see:
      // the room available is a share of a compaction target derived from this turn's
      // window and threshold, and nothing about `maxSummaryTokens` knows that. The
      // caller clamps the result regardless, so honouring it here only avoids paying
      // for tokens that are about to be cut off mid-sentence.
      const maxTokens = Math.max(
        256,
        Math.min(this.maxSummaryTokens, input.maxSummaryTokens ?? this.maxSummaryTokens),
      );

      const command = new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: systemPrompt }],
        messages: [
          {
            role: 'user',
            content: [{ text: userContent }],
          } satisfies Message,
        ],
        inferenceConfig: {
          maxTokens,
          temperature: 0,
        },
      });

      const response = await this.client.send(command);
      const outputMessage = response.output?.message;
      if (!outputMessage?.content) return undefined;

      const text = outputMessage.content
        .filter((block): block is ContentBlock.TextMember => block.text !== undefined)
        .map((block) => block.text)
        .join('');

      if (!text.trim()) return undefined;

      return { summary: text, strategy: 'llm-summarization' };
    } catch {
      // Any failure — network, throttle, model error — falls back to deterministic.
      return undefined;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders AgentMessages into a compact text representation suitable for the
 * summarization prompt. Does not include image bytes.
 */
function renderMessagesForSummarization(messages: readonly AgentMessage[]): string {
  return messages
    .map((message) => {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push(block.text.slice(0, 2_000));
        } else if (block.type === 'tool_call') {
          const inputSnippet = JSON.stringify(block.input).slice(0, 300);
          parts.push(`[tool_call: ${block.name} | input: ${inputSnippet}]`);
        } else if (block.type === 'tool_result') {
          const contentSnippet = block.content.slice(0, 500);
          parts.push(
            `[tool_result: ${block.toolCallId} | ${block.isError ? 'ERROR' : 'ok'} | ${contentSnippet}]`,
          );
        } else if (block.type === 'image') {
          parts.push(`[image: ${block.filename ?? block.mediaType}]`);
        }
      }
      return `### ${message.role.toUpperCase()}\n${parts.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Pi-style compaction system prompt.
 * Instructs the model to produce a structured summary that preserves the
 * semantically important state of the conversation.
 */
const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to produce a concise, structured summary of a conversation history that will replace the original messages in an AI agent's context window.

Preserve all of the following that are present:
- **Current goal**: What the user is ultimately trying to achieve
- **User intent**: The specific request or task in progress
- **Important constraints**: Constraints, requirements, or preferences stated by the user
- **Important decisions**: Key decisions made and the rationale behind them
- **Completed work**: What has already been accomplished
- **Current progress**: Where things stand right now
- **Pending work**: What still needs to be done
- **Next steps**: The immediate next actions planned
- **Unresolved questions**: Open questions or blockers
- **Important facts**: Key facts, values, identifiers, or names that will be needed
- **Important files**: Files that were read, created, or modified
- **Artifacts**: Any outputs created (documents, code, data)
- **Relevant tool state**: Results from tool calls that are still relevant
- **Important errors or failures**: Errors encountered and how they were handled

Rules:
- Be factual. Do not invent information that was not in the conversation.
- Be concise. Omit pleasantries and repetition.
- Prefer state over narrative: write what is currently true, not the story of how it
  came to be true. "Uses Postgres, not MySQL" is useful; "the user asked about MySQL,
  then we discussed Postgres" is not.
- If a decision was later reversed, record only the decision that stands, and list the
  reversed one under a SUPERSEDED heading so it is not acted on again.
- Use markdown headers and bullet points.
- If a section has nothing to report, omit it entirely.
- Output only the summary. Do not wrap it in quotes or add preamble.`;
