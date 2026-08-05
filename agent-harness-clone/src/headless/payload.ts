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
import { SKILL_MAX_OBJECT_BYTES } from '../platform/skill-content.js';

/**
 * The headless invocation contract: one JSON object that carries everything a run
 * needs, so nothing is read from MongoDB, S3, or the environment.
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
 * carries the model credential, the MCP credentials, and the skill instructions, so
 * whoever can post a payload chooses where those keys are sent and what the agent is
 * told to do. Stored records at least have an operator script and an audit trail in
 * front of them. Put authentication in front of any transport that accepts these.
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
 * One skill, body and all.
 *
 * A stored skill is a pointer to a `SKILL.md` in S3; here the document itself is on
 * the request, so no bucket is read and no AWS credential is needed. `document` is
 * the whole file including front matter, because that is what `parseSkill` reads and
 * what gets written to disk for the `skill` tool — the payload is not a different
 * format from the stored one, it is the same file carried a different way.
 */
export const headlessSkillSchema = z
  .object({
    name: skillName,
    /** Full `SKILL.md`, front matter included. */
    document: z.string().min(1).max(SKILL_MAX_OBJECT_BYTES),
    /**
     * Overrides the `allowed-tools` in the document's front matter for this run.
     * Must be a subset of the agent's `tools`.
     */
    allowedTools: z.array(identifier).max(200).optional(),
  })
  .strict();

export const headlessLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(1_000).optional(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    maxInputTokens: z.number().int().positive().max(10_000_000).optional(),
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
 * One request. `prompt` and the three definition blocks are the whole of it; the
 * rest are run options with defaults.
 */
export const invocationPayloadSchema = z
  .object({
    prompt: z.string().min(1).max(2_000_000),
    agent: headlessAgentSchema,
    modelProvider: headlessModelProviderSchema,
    mcpServers: z.array(headlessMcpServerSchema).max(50).default([]),
    skills: z.array(headlessSkillSchema).max(100).default([]),
    /**
     * Reuses an id in the session store, so a second payload continues the first
     * conversation. Absent starts a new one.
     */
    sessionId: z.string().min(1).max(200).optional(),
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
     * What happens to a tool no rule covered. `ask` is deliberately not offered:
     * asking suspends the run waiting for a reply no payload can send, so it would
     * hang until the caller timed out.
     */
    permissionFallback: z.enum(['allow', 'deny']).default('deny'),
    /** Attached to the session and to every stored message. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    /**
     * Include the full event log in the response. Off by default because a long run
     * with large tool results produces a response far bigger than its answer.
     */
    includeEvents: z.boolean().default(false),
  })
  .strict();

export type InvocationPayload = z.output<typeof invocationPayloadSchema>;
export type InvocationPayloadInput = z.input<typeof invocationPayloadSchema>;
export type HeadlessAgentSpec = z.output<typeof headlessAgentSchema>;
export type HeadlessModelProviderSpec = z.output<typeof headlessModelProviderSchema>;
export type HeadlessMcpServerSpec = z.output<typeof headlessMcpServerSchema>;
export type HeadlessSkillSpec = z.output<typeof headlessSkillSchema>;
export type HeadlessPermissionRule = z.output<typeof headlessPermissionRuleSchema>;

export function parseInvocationPayload(value: unknown): InvocationPayload {
  return invocationPayloadSchema.parse(value);
}
