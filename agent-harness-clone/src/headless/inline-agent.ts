import type { ContentStore } from '../content/content-store.js';
import type { RunProgressReporter } from '../core/events.js';
import type { McpElicitationHandler } from '../mcp/client.js';
import { nowIso, parseAgentRecord, type AgentRecord } from '../platform/agent-definitions.js';
import {
  PlatformAgentRegistry,
  type AgentLookup,
  type AgentStores,
  type ResolvedAgent,
  type SkillLookup,
  type TemplateLookup,
} from '../platform/agent-registry.js';
import { parseMcpServerRecord, type McpServerRecord } from '../platform/mcp-server-definitions.js';
import type { McpServerLookup } from '../platform/mcp-server-registry.js';
import {
  parseModelProviderRecord,
  type ModelProviderCapabilities,
  type ModelProviderRecord,
} from '../platform/model-provider-definitions.js';
import type { ModelProviderLookup } from '../platform/model-provider-registry.js';
import { parseSkillRecord, type SkillRecord } from '../platform/skill-definitions.js';
import { parseTemplateRecord, type TemplateRecord } from '../platform/template-definitions.js';
import type { LogContext, LogSink } from '../services/observability.js';
import type { McpServerCapabilities } from '../platform/mcp-server-definitions.js';
import type { Tool } from '../tools/tool.js';
import type {
  HeadlessMcpServerSpec,
  HeadlessModelProviderSpec,
  HeadlessSkillSpec,
  HeadlessTemplateSpec,
  InvocationPayload,
} from './payload.js';

/**
 * Assembles an agent from a payload instead of from MongoDB.
 *
 * The work here is deliberately small: it completes the payload's definition blocks
 * into the record shapes the platform already validates, synthesizes the `_id`
 * references those records use to point at each other, and hands the result to
 * `PlatformAgentRegistry`. Everything after that — the support gates, the limit
 * derivation against the provider's context window, the skill front-matter parsing,
 * the MCP handshakes, the `mcp__<server>__<tool>` namespacing — is the same code a
 * stored agent goes through.
 *
 * Reusing that path rather than writing a second one is the whole point. A separate
 * inline assembler would be shorter today and would then have to be kept in step with
 * every future change to how an agent is built, which is exactly the kind of drift
 * that produces two runtimes that disagree about what a record means.
 */

/**
 * The `agents` record's references are 24-character hex `ObjectId`s, because that is
 * what MongoDB assigns. A payload has no MongoDB, so ids are positional: the nth
 * inlined MCP server is `...00n`. They only have to be unique within their own
 * lookup, and the counter guarantees that without a hash or a random draw, so the
 * same payload always produces the same record and a failure is reproducible.
 */
function syntheticId(index: number): string {
  return (index + 1).toString(16).padStart(24, '0');
}

/** Provenance for records that were never stored. Must satisfy the `identifier` regex. */
const PAYLOAD_ORIGIN = 'headless-payload';

/**
 * What a provider record claims when the payload does not say.
 *
 * These bound the run: the input budget is derived as `contextWindow -
 * maxOutputTokens` less a safety margin, so these numbers decide what the agent's
 * `compactionThresholdPercent` is a percentage *of*, and an `agent.limits`
 * reservation above them is refused. Chosen to be unremarkable for a current
 * frontier model rather than generous; a payload that knows its model should say so.
 */
const DEFAULT_MODEL_CAPABILITIES: ModelProviderCapabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: false,
  reportsCost: false,
};

/**
 * Tools only, and timeouts wide enough for a slow first handshake and a long tool
 * call. Resources and prompts are off because a payload that wants them can say so,
 * and advertising a surface the server does not have costs a round trip per run.
 */
const DEFAULT_MCP_CAPABILITIES: McpServerCapabilities = {
  tools: true,
  resources: false,
  prompts: false,
  elicitation: false,
  connectTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
};

/** Matches the `maxTurns` ceiling `AgentSessionConfig` defaults to. */
const DEFAULT_MAX_TURNS = 24;
const RESPONSE_PRESENTATION_TOOLS = new Set([
  'create_markdown_artifact',
  'create_html_artifact',
  'create_document_artifact',
  'create_spreadsheet_artifact',
  'create_csv_artifact',
  'create_json_artifact',
  'create_code_artifact',
]);

export type InlineAgentOptions = {
  /**
   * Every tool the host built, by name. The payload's `agent.tools` selects from
   * these, and omitting it selects all of them.
   */
  localTools: readonly Tool[];
  /** Answers an MCP server's `elicitation/create`. */
  elicitationHandler?: McpElicitationHandler;
  /** Defaults to `console.warn`, as in `PlatformAgentRegistry`. */
  logger?: (message: string) => void;
  logSink?: LogSink;
  logContext?: LogContext;
  /** Replaces the SDK-backed S3 reader. Used by tests and embedding hosts. */
  skillContentStore?: ContentStore;
  /** Reports skill downloads and MCP connections while assembly is happening. */
  onProgress?: RunProgressReporter;
};

/**
 * Builds the four records the registry reads, then resolves them.
 *
 * The returned `close` is the registry's own: it shuts every MCP connection this
 * agent opened and deletes the temporary skill directory. Call it from a `finally` —
 * on the failure path as much as the success one, since a payload that failed
 * mid-turn has already spawned its stdio servers.
 */
export async function resolveInlineAgent(
  payload: InvocationPayload,
  options: InlineAgentOptions,
): Promise<ResolvedAgent> {
  const timestamp = nowIso();
  const modelProvider = completeModelProvider(payload.modelProvider, timestamp);
  const mcpServers = payload.mcpServers.map((spec) => completeMcpServer(spec, timestamp));
  const skills = payload.skills.map((spec) => completeSkill(spec, timestamp));
  const templates = payload.templates.map((spec) => completeTemplate(spec, timestamp));

  const modelProviderId = syntheticId(0);
  const mcpServerIds = mcpServers.map((_, index) => syntheticId(index));
  const skillIds = skills.map((_, index) => syntheticId(index));
  const templateIds = templates.map((_, index) => syntheticId(index));

  const record = completeAgent(payload, {
    modelProviderId,
    mcpServerIds,
    skillIds,
    templateIds,
    availableTools: options.localTools,
    timestamp,
  });

  const stores: AgentStores = {
    agents: singleAgentLookup(record),
    modelProviders: singleRecordLookup(modelProviderId, modelProvider),
    skills: skillLookup(skillIds, skills),
    templates: templateLookup(templateIds, templates),
    mcpServers: mcpServerLookup(mcpServerIds, mcpServers),
  };

  const registry = new PlatformAgentRegistry(stores, {
    localTools: options.localTools,
    ...(options.skillContentStore === undefined ? {} : { contentStore: options.skillContentStore }),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
    ...(options.logContext === undefined ? {} : { logContext: options.logContext }),
    ...(options.elicitationHandler === undefined
      ? {}
      : { elicitationHandler: options.elicitationHandler }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  return registry.resolveRecord(record);
}

/**
 * `auth` is inferred from whether a credential was supplied, because the two always
 * agree in practice and both record schemas reject the combinations where they do
 * not: `bearer` without an `apiKey`, or an `apiKey` under `none`.
 */
function completeModelProvider(
  spec: HeadlessModelProviderSpec,
  timestamp: string,
): ModelProviderRecord {
  return parseModelProviderRecord({
    ...spec,
    auth: spec.auth ?? { kind: spec.apiKey === undefined ? 'none' : 'bearer' },
    capabilities: spec.capabilities ?? DEFAULT_MODEL_CAPABILITIES,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: PAYLOAD_ORIGIN,
  });
}

/**
 * A stdio server is always `none`: a pipe carries no request to authenticate, and the
 * record schema refuses anything else. An HTTP or SSE server with a credential gets
 * `bearer`, which is the header `PlatformMcpServerRegistry` sets.
 */
function completeMcpServer(spec: HeadlessMcpServerSpec, timestamp: string): McpServerRecord {
  const kind = spec.transport === 'stdio' || spec.apiKey === undefined ? 'none' : 'bearer';
  return parseMcpServerRecord({
    ...spec,
    auth: spec.auth ?? { kind },
    capabilities: spec.capabilities ?? DEFAULT_MCP_CAPABILITIES,
    enabled: true,
    // Not `autoConnect`: an agent references its servers explicitly, and this one
    // references all of them. The flag only selects servers for the database path.
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: PAYLOAD_ORIGIN,
  });
}

function completeSkill(spec: HeadlessSkillSpec, timestamp: string): SkillRecord {
  return parseSkillRecord({
    name: spec.name,
    uri: spec.uri,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: PAYLOAD_ORIGIN,
  });
}

function completeTemplate(spec: HeadlessTemplateSpec, timestamp: string): TemplateRecord {
  return parseTemplateRecord({
    name: spec.name,
    uri: spec.uri,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: PAYLOAD_ORIGIN,
  });
}

/**
 * Parsed through `parseAgentRecord` rather than assembled and trusted, so the payload
 * gets the cross-field checks a stored record gets: duplicate tool names, duplicate
 * server references, and a skill override naming a tool the agent does not have.
 */
function completeAgent(
  payload: InvocationPayload,
  refs: {
    modelProviderId: string;
    mcpServerIds: readonly string[];
    skillIds: readonly string[];
    templateIds: readonly string[];
    availableTools: readonly Tool[];
    timestamp: string;
  },
): AgentRecord {
  const { agent } = payload;
  // Omitting `tools` offers the whole catalogue. Deduplicated because two factories
  // could contribute the same name and the record schema rejects a repeat.
  const availableToolNames = refs.availableTools.map((tool) => tool.name);
  // Presentation tools are part of the response transport, not a workspace
  // capability. Keep them available when the host configured them even if an agent
  // uses an explicit allowlist for operational tools; otherwise every stored agent
  // would need a migration before it could return a document.
  const presentationTools = availableToolNames.filter((name) =>
    RESPONSE_PRESENTATION_TOOLS.has(name),
  );
  const tools = [
    ...new Set(agent.tools ? [...agent.tools, ...presentationTools] : availableToolNames),
  ];
  return parseAgentRecord({
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    systemPrompt: agent.systemPrompt,
    modelProviderId: refs.modelProviderId,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    tools,
    skills: payload.skills.map((spec, index) => ({
      skillId: refs.skillIds[index] as string,
      ...(spec.allowedTools === undefined ? {} : { allowedTools: spec.allowedTools }),
    })),
    templates: payload.templates.map((_spec, index) => ({
      templateId: refs.templateIds[index] as string,
    })),
    mcpServerIds: [...refs.mcpServerIds],
    limits: {
      maxTurns: agent.limits?.maxTurns ?? DEFAULT_MAX_TURNS,
      ...(agent.limits?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: agent.limits.maxOutputTokens }),
      ...(agent.limits?.compactionThresholdPercent === undefined
        ? {}
        : { compactionThresholdPercent: agent.limits.compactionThresholdPercent }),
    },
    enabled: true,
    createdAt: refs.timestamp,
    updatedAt: refs.timestamp,
    createdBy: PAYLOAD_ORIGIN,
  });
}

/**
 * The lookups below satisfy the read interfaces the registry depends on. They exist
 * because the registry takes `AgentStores`, not a Mongo client — the seam was already
 * there, and these are four objects rather than a fifth store implementation.
 */
function singleAgentLookup(record: AgentRecord): AgentLookup {
  return {
    get: async (id) => (id === syntheticId(0) ? record : undefined),
    getByName: async (name) => (name === record.name ? record : undefined),
    getDefault: async () => record,
  };
}

function singleRecordLookup(id: string, record: ModelProviderRecord): ModelProviderLookup {
  return {
    get: async (candidate) => (candidate === id ? record : undefined),
    getByName: async (name) => (name === record.name ? record : undefined),
    getDefault: async () => record,
  };
}

function skillLookup(ids: readonly string[], records: readonly SkillRecord[]): SkillLookup {
  const index = new Map(ids.map((id, position) => [id, records[position] as SkillRecord]));
  return { get: async (id) => index.get(id) };
}

function templateLookup(
  ids: readonly string[],
  records: readonly TemplateRecord[],
): TemplateLookup {
  const index = new Map(ids.map((id, position) => [id, records[position] as TemplateRecord]));
  return { get: async (id) => index.get(id) };
}

function mcpServerLookup(
  ids: readonly string[],
  records: readonly McpServerRecord[],
): McpServerLookup {
  const index = new Map(ids.map((id, position) => [id, records[position] as McpServerRecord]));
  return {
    get: async (id) => index.get(id),
    getByName: async (name) => records.find((record) => record.name === name),
    // Every inlined server is referenced by the payload's agent, so the
    // `autoConnect` selection the database path uses has nothing to narrow here.
    listAutoConnect: async () => [...records],
  };
}
