import { z } from 'zod';
import {
  mcpServerAuthSchema,
  mcpServerCapabilitiesSchema,
  mcpServerWireSchema,
} from '../platform/mcp-server-definitions.js';
import {
  modelProviderAuthSchema,
  modelProviderCapabilitiesSchema,
  modelProviderWireSchema,
} from '../platform/model-provider-definitions.js';
import { S3_URI_PATTERN } from '../content/s3-uri.js';
import { templateFormatSchema } from '../platform/template-definitions.js';

/**
 * The headless invocation contract: one JSON object that carries everything a run
 * needs. Agent configuration is not read from MongoDB or the environment; skill
 * bodies are addressed by URI and fetched from S3 during preparation.
 *
 * This is the same information the platform collections hold, moved onto the
 * request. `resolveAgentFromDatabase` reads an `agents` record whose
 * `modelProviderId`, `mcpServerIds`, and `skills[].skillId` point into three other
 * collections; here the caller inlines those documents instead of naming them, and
 * `resolveInlinePayload` synthesizes the references so the same
 * `PlatformAgentRegistry` assembles the agent. That keeps one assembly path — one
 * place where limits are derived, tools are namespaced, and support gates run —
 * rather than a second implementation that drifts from the stored one.
 *
 * What moves onto the request also moves the trust boundary onto it: the payload
 * carries the model credential, the MCP credentials, and the skill addresses, so
 * whoever can post a payload chooses where those keys are sent and which objects the
 * runtime role reads. Put authentication in front of any transport that accepts these,
 * and scope the runtime's S3 policy to skill prefixes only.
 *
 * Fields are camelCase and every object is `.strict()`, matching the rest of the
 * codebase: an unrecognised key is a rejected payload rather than a silently ignored
 * one, because a misspelled `systemPrompt` that runs anyway is worse than one that
 * fails.
 */

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/**
 * Narrower than `identifier`: a skill name becomes a directory under the run's
 * temporary directory, so no dots. Matches `skill-definitions.ts`.
 */
const skillName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const apiKeyValue = z.string().min(1).max(8192);
const headerMap = z.record(z.string(), z.string());

/**
 * The model, the endpoint, and the credential, inline.
 *
 * `auth` and `capabilities` are optional here and required on the stored record.
 * They are filled in by `completeModelProvider`, because a caller that has already
 * said `apiKey` has said `bearer`, and a caller that wants a default context window
 * should not have to restate six booleans to get one. Supplying either overrides the
 * default completely.
 */
export const headlessModelProviderSchema = z
  .object({
    name: identifier.default('payload-model-provider'),
    provider: z.enum(['openrouter', 'openai-compatible', 'bedrock']),
    model: z.string().min(1).max(300),
    /** Required for every provider except `openrouter`, which has a known default. */
    baseURL: z.url().optional(),
    apiKey: apiKeyValue.optional(),
    auth: modelProviderAuthSchema.optional(),
    capabilities: modelProviderCapabilitiesSchema.optional(),
    wire: modelProviderWireSchema.optional(),
    headers: headerMap.optional(),
  })
  .strict();

/**
 * One MCP server, inline. Same field set as an `mcp_servers` record minus identity
 * and provenance, with `auth` and `capabilities` defaulted the same way.
 */
export const headlessMcpServerSchema = z
  .object({
    name: identifier,
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().min(1).max(1000).optional(),
    args: z.array(z.string().max(4096)).max(100).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.url().optional(),
    apiKey: apiKeyValue.optional(),
    auth: mcpServerAuthSchema.optional(),
    capabilities: mcpServerCapabilitiesSchema.optional(),
    wire: mcpServerWireSchema.optional(),
    headers: headerMap.optional(),
  })
  .strict();

/**
 * One skill reference.
 *
 * The request carries the address rather than the `SKILL.md` bytes. During agent
 * preparation the runtime downloads that object, writes it into the run's private
 * temporary skill directory, and parses it through the existing skill path. The AWS
 * credential belongs to the host and never travels on this payload.
 *
 * `name` remains beside the URI because it is the stable handle the model passes to
 * the `skill` tool and the safe directory name used on disk. It is not document body.
 */
export const headlessSkillSchema = z
  .object({
    name: skillName,
    /** Full address of the `SKILL.md`, normally `s3://bucket/key`. */
    uri: z.string().min(1).max(2_048).regex(S3_URI_PATTERN),
    /**
     * Overrides the `allowed-tools` in the document's front matter for this run.
     * Must be a subset of the agent's `tools`.
     */
    allowedTools: z.array(identifier).max(200).optional(),
  })
  .strict();

/**
 * One always-on template. Its UTF-8 text is fetched from S3 during preparation and
 * appended to the resolved system prompt in payload order.
 */
export const headlessTemplateSchema = z
  .object({
    name: skillName,
    uri: z.string().min(1).max(2_048).regex(S3_URI_PATTERN),
    format: templateFormatSchema.default('html'),
  })
  .strict();

export const headlessLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(1_000).optional(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    /**
     * Percentage of the derived input budget at which context shrinks. There is no
     * input token field: the budget comes from the model provider's own
     * `contextWindow` less the reserved reply, and this says how full it may get.
     */
    compactionThresholdPercent: z.number().int().min(1).max(99).optional(),
  })
  .strict();

/**
 * The agent itself: the prompt, which local tools it may call, and its ceilings.
 *
 * `tools` names local tools only. MCP tools are contributed by `mcpServers` and
 * namespaced `mcp__<server>__<tool>` at connect time, so naming one here is an
 * error the registry reports rather than a silent no-op.
 */
export const headlessAgentSchema = z
  .object({
    name: identifier.default('payload-agent'),
    description: z.string().max(1_000).optional(),
    systemPrompt: z.string().min(1).max(500_000),
    /** Overrides `modelProvider.model` for this run. */
    model: z.string().min(1).max(300).optional(),
    /**
     * Omit to offer every tool the host built. Naming tools explicitly is the safer
     * choice and the one a stored record has to make; the open default exists so a
     * payload does not have to enumerate the catalogue to get a working run.
     */
    tools: z.array(identifier).max(200).optional(),
    limits: headlessLimitsSchema.optional(),
  })
  .strict();

export const headlessPermissionRuleSchema = z
  .object({
    /** Tool name, `*` wildcards allowed. */
    tool: z.string().min(1).max(200),
    decision: z.enum(['allow', 'deny']),
    /** Matched against the request's command or path, `*` wildcards allowed. */
    inputPattern: z.string().min(1).max(2_000).optional(),
    source: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * A bounded, text-only transcript supplied by a trusted client when a durable
 * runtime session cannot be found (for example after an AgentCore cold start).
 * Tool calls and reasoning are intentionally excluded from this recovery path.
 */
export const headlessSessionSchema = z
  .object({
    mode: z.enum(['persistent', 'stateless']).default('persistent'),
    history: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            role: z.enum(['user', 'assistant']),
            content: z.string().max(2_000_000),
            createdAt: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();

/**
 * One request. `prompt` and the three definition blocks are the whole of it; the
 * rest are run options with defaults.
 */
/**
 * A file the caller sent with this turn, already reduced to model input.
 *
 * The caller extracts, not the runtime. A `text` attachment carries the content of
 * whatever it was — a source file, a CSV, a Word document, a spreadsheet — because
 * that text is a fraction of the original's size and survives the JSON body limits
 * a workbook would not. An `image` carries base64 bytes for a vision model.
 */
export const invocationAttachmentSchema = z
  .object({
    kind: z.enum(['text', 'image']),
    filename: z.string().min(1).max(300),
    /** Media type of the original file, or of the image bytes for `image`. */
    contentType: z.string().min(1).max(200),
    /** Size of the original file, for reporting rather than for reading. */
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    /** Fence label for a text attachment, such as `python` or `csv`. */
    language: z.string().min(1).max(50).optional(),
    /** Extracted content. Required when `kind` is `text`. */
    text: z.string().max(2_000_000).optional(),
    /** Base64 bytes, no data-URL prefix. Required when `kind` is `image`. */
    data: z.string().max(8_000_000).optional(),
    /** What extraction had to do, surfaced to the model beside the content. */
    notes: z.array(z.string().min(1).max(200)).max(8).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'text' && !value.text) {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'A text attachment requires extracted text',
      });
    }
    if (value.kind === 'image') {
      if (!value.data) {
        context.addIssue({
          code: 'custom',
          path: ['data'],
          message: 'An image attachment requires base64 data',
        });
      }
      if (!value.contentType.startsWith('image/')) {
        context.addIssue({
          code: 'custom',
          path: ['contentType'],
          message: 'An image attachment requires an image/* content type',
        });
      }
    }
  });

export type InvocationAttachment = z.output<typeof invocationAttachmentSchema>;

export const invocationPayloadSchema = z
  .object({
    /** Normal conversational turn by default; `compact` is a control-plane operation. */
    operation: z.enum(['turn', 'compact']).default('turn'),
    /**
     * Empty for an explicit `compact` operation, or when attachments are present on
     * a normal turn. Existing payloads omit `operation` and retain turn validation.
     */
    prompt: z.string().max(2_000_000),
    /** Files sent with this turn. Not persisted as attachments; see `prepareAttachments`. */
    attachments: z.array(invocationAttachmentSchema).max(20).default([]),
    agent: headlessAgentSchema,
    modelProvider: headlessModelProviderSchema,
    mcpServers: z.array(headlessMcpServerSchema).max(50).default([]),
    skills: z.array(headlessSkillSchema).max(100).default([]),
    templates: z.array(headlessTemplateSchema).max(100).default([]),
    /**
     * Reuses an id in the session store, so a second payload continues the first
     * conversation. Absent starts a new one.
     */
    sessionId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .optional(),
    /**
     * Persistent mode resumes the server-side transcript. `history` is used only
     * when that transcript is missing, making it a cold-start recovery mechanism
     * rather than a second copy appended on every turn.
     */
    session: headlessSessionSchema.optional(),
    /**
     * Where the file and shell tools are rooted. Absent uses a fresh directory per
     * run, which is what makes concurrent payloads safe to serve from one process.
     */
    workingDirectory: z.string().min(1).max(4_096).optional(),
    /**
     * `deny` refuses every tool, `bypass` allows every tool including shell, `plan`
     * allows only read-only tools, `default` consults `permissionRules` then
     * `permissionFallback`.
     */
    permissionMode: z.enum(['default', 'plan', 'bypass', 'deny']).default('default'),
    /**
     * Applied before the fallback, in order, first match wins. This is how a payload
     * opts into writes: `[{ tool: 'write_file', decision: 'allow' }]`.
     */
    permissionRules: z.array(headlessPermissionRuleSchema).max(200).default([]),
    /**
     * What happens to a tool no rule covered.
     *
     * `ask` suspends the run on a `permission.requested` event until something
     * answers it, so it is only meaningful to a caller that is both watching a
     * stream and able to send the answer back. The runner refuses it otherwise —
     * see `HeadlessRunOptions.interactivePermissions` — because an unanswerable
     * question hangs until the caller times out.
     */
    permissionFallback: z.enum(['allow', 'deny', 'ask']).default('deny'),
    /** Attached to the session and to every stored message. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    /**
     * Include the full event log in the response. Off by default because a long run
     * with large tool results produces a response far bigger than its answer.
     */
    includeEvents: z.boolean().default(false),
    /**
     * Compact the conversation context before this turn's first model request,
     * whatever the threshold policy would have decided on its own.
     *
     * For a client that offers "compact context" as an explicit action. It applies
     * to this run only; the turns after it are governed by the policy again. The
     * canonical transcript is untouched either way — compaction changes what the
     * model is shown, not what the session stores.
     */
    compactContext: z.boolean().default(false),
    /**
     * The preferred response encoding when the transport did not state one, so a
     * stored agent definition can carry "this one streams" without its caller
     * restating it per request.
     *
     * A preference, not an instruction: an explicit `Accept` or `?stream=` still
     * decides, because that header is what the caller can actually read and a body
     * must not be able to make it read something else. Left `optional` rather than
     * defaulted so "unset" stays distinguishable from "asked for buffered".
     */
    stream: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === 'turn' && !value.prompt.trim() && value.attachments.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'Provide a prompt, one or more attachments, or both',
      });
    }
    if (value.operation === 'compact' && value.attachments.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Context compaction does not accept attachments',
      });
    }
    if (value.operation === 'compact' && value.session?.mode === 'stateless') {
      context.addIssue({
        code: 'custom',
        path: ['session', 'mode'],
        message: 'Context compaction requires a persistent session',
      });
    }
  });

export type InvocationPayload = z.output<typeof invocationPayloadSchema>;
export type InvocationPayloadInput = z.input<typeof invocationPayloadSchema>;
export type HeadlessAgentSpec = z.output<typeof headlessAgentSchema>;
export type HeadlessModelProviderSpec = z.output<typeof headlessModelProviderSchema>;
export type HeadlessMcpServerSpec = z.output<typeof headlessMcpServerSchema>;
export type HeadlessSkillSpec = z.output<typeof headlessSkillSchema>;
export type HeadlessTemplateSpec = z.output<typeof headlessTemplateSchema>;
export type HeadlessPermissionRule = z.output<typeof headlessPermissionRuleSchema>;
export type HeadlessSessionSpec = z.output<typeof headlessSessionSchema>;

export function parseInvocationPayload(value: unknown): InvocationPayload {
  return invocationPayloadSchema.parse(value);
}
