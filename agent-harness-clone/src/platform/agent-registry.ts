import type { ContentStore } from '../content/content-store.js';
import type { AgentLimits } from '../core/agent-session.js';
import { AgentHarnessError } from '../core/errors.js';
import type { RunProgressReporter } from '../core/events.js';
import type { McpConnection, McpElicitationHandler } from '../mcp/client.js';
import type { ModelProvider } from '../models/provider.js';
import type { LogContext, LogSink } from '../services/observability.js';
import type { Skill } from '../skills/skills.js';
import { createSkillTool, parseSkill, SkillRegistry } from '../skills/skills.js';
import type { Tool } from '../tools/tool.js';
import { TempSkillDirectory } from '../skills/temp-skill-directory.js';
import type { AgentRecord } from './agent-definitions.js';
import { assertAgentRuntimeSupport } from './agent-support.js';
import type { SkillRecord } from './skill-definitions.js';
import { SkillContentStores } from './skill-content.js';
import type { McpServerRecord } from './mcp-server-definitions.js';
import type { McpServerLookup } from './mcp-server-registry.js';
import { PlatformMcpServerRegistry } from './mcp-server-registry.js';
import type { ModelProviderRecord } from './model-provider-definitions.js';
import type { ModelProviderLookup } from './model-provider-registry.js';
import { PlatformModelProviderRegistry } from './model-provider-registry.js';

/** The read surface the registry needs; satisfied by `MongoAgentStore`. */
export interface AgentLookup {
  get(id: string): Promise<AgentRecord | undefined>;
  getByName(name: string): Promise<AgentRecord | undefined>;
  getDefault(): Promise<AgentRecord | undefined>;
}

/**
 * The read surface the registry needs; satisfied by `MongoSkillStore`.
 *
 * By `_id` only. An agent references skills by id, and looking one up by name is not
 * something resolution needs to do.
 */
export interface SkillLookup {
  get(id: string): Promise<SkillRecord | undefined>;
}

/**
 * The four collections an agent is assembled from. `agents` holds the record, and the
 * other three are the master collections its `_id` references point into, so the
 * credential for the model and the credentials for MCP are read from there and never
 * from the agent record.
 *
 * There is no collection for skill content. A `skills` record carries the whole S3
 * address, and the credential to read it comes from the environment.
 */
export type AgentStores = {
  agents: AgentLookup;
  modelProviders: ModelProviderLookup;
  skills: SkillLookup;
  mcpServers: McpServerLookup;
};

export type PlatformAgentRegistryOptions = {
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
  /** Structured model/MCP lifecycle records produced while resolving this agent. */
  logSink?: LogSink;
  /** Correlation fields copied onto structured model/MCP lifecycle records. */
  logContext?: LogContext;
  /**
   * Every local tool the running host offers, by the `name` each factory sets.
   * A record may name any subset of these; naming one the host did not offer is
   * reported rather than dropped, because a session missing a tool its prompt
   * relies on fails in a way that is hard to read from the transcript.
   *
   * Host wiring, not record data, so it is set once here rather than per call.
   */
  localTools?: readonly Tool[];
  /**
   * Answers an MCP server's `elicitation/create`, passed through to
   * `PlatformMcpServerRegistry`. Records that ask for elicitation without one
   * resolve anyway, with the capability left unadvertised.
   */
  elicitationHandler?: McpElicitationHandler;
  /**
   * Where the skill documents this agent references are read from.
   *
   * Supplied by the caller rather than built here, because a skill body arrives on
   * the invocation payload and is served from an `InMemoryContentStore` keyed by the
   * address each synthesized record carries (`src/headless/inline-agent.ts`). Needed
   * only when the record references a skill; a record with none resolves without it.
   */
  contentStore?: ContentStore;
  /**
   * Reports the long parts of assembly — downloading skill documents, connecting
   * MCP servers — while they happen. Optional: a caller that is not watching a
   * stream has the structured log for the same facts after the fact.
   */
  onProgress?: RunProgressReporter;
};

/**
 * One agent, assembled and ready to spread into `createAgentSession`.
 *
 * `tools` is the whole set in the order the session should receive it: the
 * record's local tools, then the `skill` tool when the record has skills, then
 * the MCP tools last and already namespaced `mcp__<server>__<tool>`, so a stored
 * server cannot shadow a local tool.
 */
export type ResolvedAgent = {
  record: AgentRecord;
  provider: ModelProvider;
  /** The `model_providers` record the agent referenced. Carries the credential. */
  modelProvider: ModelProviderRecord;
  /** Read straight off the agent record. */
  systemPrompt: string;
  /**
   * The `skills` records the agent referenced, in the order it lists them. These give
   * each skill's name and where it came from; the descriptions and tool lists read out
   * of those documents are in `skills`.
   */
  skillRecords: readonly SkillRecord[];
  /**
   * Where the skill bodies were written for this run. Removed by `close`, so the
   * path is only valid for the length of the command.
   */
  skillDirectory: string;
  /** Present only when the record overrides the provider record's model. */
  model?: string;
  tools: readonly Tool[];
  /** Holds the record's inline skills, backing the `skill` tool. */
  skills: SkillRegistry;
  mcpConnections: readonly McpConnection[];
  mcpRecords: readonly McpServerRecord[];
  limits: AgentLimits;
  /**
   * Closes every MCP connection opened for this agent and deletes the temporary
   * skill directory. Call it from a `finally`: the directory holds instruction files
   * that should not outlive the command, on the failure path as much as the success
   * one.
   */
  close(): Promise<void>;
};

/**
 * Turns `agents` records into the pieces a session is built from. Named for
 * symmetry with `PlatformModelProviderRegistry` and `PlatformMcpServerRegistry`,
 * and it composes both rather than reimplementing either.
 */
export class PlatformAgentRegistry {
  private readonly logger: (message: string) => void;
  private readonly modelProviders: PlatformModelProviderRegistry;
  private readonly skillContent: SkillContentStores;
  private readonly mcpServers: PlatformMcpServerRegistry;

  constructor(
    private readonly stores: AgentStores,
    private readonly options: PlatformAgentRegistryOptions = {},
  ) {
    this.logger = options.logger ?? ((message) => console.warn(message));
    this.modelProviders = new PlatformModelProviderRegistry(stores.modelProviders, {
      logger: this.logger,
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      ...(options.logContext === undefined ? {} : { logContext: options.logContext }),
    });
    this.skillContent = new SkillContentStores({
      ...(options.contentStore === undefined ? {} : { contentStore: options.contentStore }),
    });
    this.mcpServers = new PlatformMcpServerRegistry(stores.mcpServers, {
      logger: this.logger,
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      ...(options.logContext === undefined ? {} : { logContext: options.logContext }),
      ...(options.elicitationHandler === undefined
        ? {}
        : { elicitationHandler: options.elicitationHandler }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  }

  async resolveById(id: string): Promise<ResolvedAgent> {
    const record = await this.stores.agents.get(id);
    if (!record) throw new AgentHarnessError(`Unknown agent: ${id}`, 'AGENT_NOT_FOUND');
    return this.resolveRecord(record);
  }

  async resolveByName(name: string): Promise<ResolvedAgent> {
    const record = await this.stores.agents.getByName(name);
    if (!record) throw new AgentHarnessError(`Unknown agent: ${name}`, 'AGENT_NOT_FOUND');
    return this.resolveRecord(record);
  }

  async resolveDefault(): Promise<ResolvedAgent> {
    const record = await this.stores.agents.getDefault();
    if (!record) throw new AgentHarnessError('No default agent', 'AGENT_NOT_FOUND');
    return this.resolveRecord(record);
  }

  /**
   * Reads the referenced master-collection records, builds the provider, connects
   * the MCP servers, and collects the tools. MCP connections opened before a
   * later step fails are closed before the error leaves, so a rejected agent
   * leaves no process behind.
   */
  async resolveRecord(record: AgentRecord): Promise<ResolvedAgent> {
    // Defence in depth: a record may predate a change to AGENT_RUNTIME_SUPPORT.
    assertAgentRuntimeSupport(record);
    if (!record.enabled) {
      throw new AgentHarnessError(`Agent is disabled: ${record.name}`, 'AGENT_DISABLED');
    }

    const modelProvider = await this.stores.modelProviders.get(record.modelProviderId);
    if (!modelProvider) {
      throw new AgentHarnessError(
        `Agent '${record.name}' references model provider _id ${record.modelProviderId}, which ` +
          'is no longer in model_providers. Point the agent at an existing record with ' +
          'npx tsx scripts/agent/editAgent.ts.',
        'MODEL_PROVIDER_NOT_FOUND',
      );
    }
    const provider = await this.modelProviders.resolveRecord(modelProvider);
    const limits = resolveLimits(record, modelProvider);

    // Skill documents are downloaded before any MCP process is spawned, so a dangling
    // reference or a missing object fails while there is still least to clean up. They
    // are read eagerly rather than on demand for the reason the service resolves its
    // provider before opening the listener: a misconfigured record should fail at
    // startup, not part way through a conversation.
    const directory = await TempSkillDirectory.create();
    let skillRecords: readonly SkillRecord[] = [];
    let skills = new SkillRegistry();
    try {
      if (record.skills.length > 0) {
        this.options.onProgress?.('skills', `Loading ${record.skills.length} skill document(s)`, {
          total: record.skills.length,
        });
      }
      const materialized = await this.materializeSkills(record, directory);
      skillRecords = materialized.records;
      skills = new SkillRegistry(materialized.skills);
      if (skillRecords.length > 0) {
        this.options.onProgress?.('skills', `Loaded ${skillRecords.length} skill document(s)`, {
          skills: skillRecords.map((skill) => skill.name),
        });
      }
    } catch (error) {
      await directory.dispose();
      throw error;
    }

    const mcpRecords = await this.mcpRecordsFor(record).catch(async (error: unknown) => {
      await directory.dispose();
      throw error;
    });
    const mcpConnections = await this.mcpServers
      .resolveRecords(mcpRecords)
      .catch(async (error: unknown) => {
        await directory.dispose();
        throw error;
      });
    const release = async (): Promise<void> => {
      await closeAll(mcpConnections);
      await directory.dispose();
    };
    try {
      const tools = [
        ...this.localToolsFor(record),
        ...(record.skills.length > 0 ? [createSkillTool(skills)] : []),
        ...(await mcpTools(mcpRecords, mcpConnections)),
      ];
      return {
        record,
        provider,
        modelProvider,
        systemPrompt: record.systemPrompt,
        skillRecords,
        skillDirectory: directory.path,
        ...(record.model === undefined ? {} : { model: record.model }),
        tools,
        skills,
        mcpConnections,
        mcpRecords,
        limits,
        close: release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * Reads each referenced `skills` pointer, downloads the document it names, and
   * writes it into this run's temporary directory.
   *
   * The record contributes the name and the location. Everything that *describes* the
   * skill — its description and its `allowedTools` — is parsed out of the downloaded
   * document's front matter by `parseSkill`, the same function that reads a skill off
   * local disk, so those live in the file its author wrote and MongoDB cannot hold a
   * stale copy of them.
   *
   * Each skill names its own bucket, so a shared skills bucket and a per-team one can
   * coexist; the reader for each is built once per distinct bucket rather than once
   * per skill.
   */
  private async materializeSkills(
    record: AgentRecord,
    directory: TempSkillDirectory,
  ): Promise<{ records: SkillRecord[]; skills: Skill[] }> {
    const records: SkillRecord[] = [];
    const skills: Skill[] = [];
    for (const entry of record.skills) {
      const skill = await this.stores.skills.get(entry.skillId);
      if (!skill) {
        throw new AgentHarnessError(
          `Agent '${record.name}' references skill _id ${entry.skillId}, which is no longer in ` +
            'skills. Remove it from the agent, or add the skill back.',
          'SKILL_NOT_FOUND',
        );
      }
      if (!skill.enabled) {
        throw new AgentHarnessError(
          `Agent '${record.name}' references skill '${skill.name}', which is disabled.`,
          'SKILL_DISABLED',
        );
      }

      // The address is parsed and the reader for its bucket resolved together. Readers
      // are cached per bucket inside `SkillContentStores`, so a run touching two
      // buckets builds two rather than one per skill.
      const { location, store } = this.skillContent.locate(
        skill.uri,
        `Agent '${record.name}' skill '${skill.name}'`,
      );
      const body = await load(store, location.key, skill, record.name);

      // Written as `<name>/SKILL.md`, the layout `loadSkillsDirectory` reads, so a
      // downloaded skill is an ordinary skill file rather than a special case. The
      // whole document goes to disk, front matter included, so what is on disk is
      // what is in the bucket.
      const source = await directory.write(skill.name, body);
      // Parsed with the source path, so a document with no `name` in its front matter
      // falls back to the directory it was just written to — which is the record's
      // name. The record is the authority on the name either way; the front matter is
      // read for the description and the tool list.
      const parsed = parseSkill(body, source);

      // An override was checked against the agent's tools by the schema; a default
      // from the document was not, because it did not exist until just now.
      const allowedTools = entry.allowedTools ?? parsed.allowedTools;
      if (entry.allowedTools === undefined) {
        assertAllowedToolsAvailable(record, skill.name, allowedTools);
      }

      records.push(skill);
      skills.push({
        name: skill.name,
        description: parsed.description,
        instructions: parsed.instructions,
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        source,
      });
    }
    return { records, skills };
  }

  /**
   * An agent references its servers, so an empty list is an agent with no MCP
   * tools rather than one that falls back to the `autoConnect` set: two
   * selections for the same run would make the transcript impossible to account
   * for.
   */
  private async mcpRecordsFor(record: AgentRecord): Promise<McpServerRecord[]> {
    const records: McpServerRecord[] = [];
    for (const id of record.mcpServerIds) {
      const server = await this.stores.mcpServers.get(id);
      if (!server) {
        throw new AgentHarnessError(
          `Agent '${record.name}' references MCP server _id ${id}, which is no longer in ` +
            'mcp_servers. Remove it from the agent, or add the server back.',
          'MCP_SERVER_NOT_FOUND',
        );
      }
      records.push(server);
    }
    return records;
  }

  private localToolsFor(record: AgentRecord): Tool[] {
    const available = new Map((this.options.localTools ?? []).map((tool) => [tool.name, tool]));
    return record.tools.map((name) => {
      const tool = available.get(name);
      if (tool) return tool;
      throw new AgentHarnessError(
        `Agent '${record.name}' names tool '${name}', which this host does not offer. ` +
          `Available: ${[...available.keys()].join(', ') || 'none'}.`,
        'AGENT_TOOL_NOT_AVAILABLE',
      );
    });
  }
}

/**
 * Downloads one skill document, naming the agent and the key that failed.
 *
 * Unverified by design: the record is a pointer with no digest on it, so there is
 * nothing to hold the bytes to. See `skillShape` in `skill-definitions.ts` for what
 * that costs.
 */
async function load(
  store: ContentStore,
  key: string,
  skill: SkillRecord,
  agentName: string,
): Promise<string> {
  try {
    return (await store.load(key)).text;
  } catch (error) {
    if (!(error instanceof AgentHarnessError)) throw error;
    throw new AgentHarnessError(
      `Agent '${agentName}' skill '${skill.name}': ${error.message}`,
      error.code,
      error.recoverable,
      { cause: error },
    );
  }
}

/**
 * A skill's own `allowedTools` is checked against the agent here rather than in the
 * schema, because the skill is not in the database: adding a tool to a shared skill
 * document must not silently advertise it to an agent that does not have it. An
 * override on the agent's own entry is checked by the schema instead.
 */
function assertAllowedToolsAvailable(
  record: AgentRecord,
  skillName: string,
  allowedTools: readonly string[] | undefined,
): void {
  for (const tool of allowedTools ?? []) {
    if (record.tools.includes(tool)) continue;
    throw new AgentHarnessError(
      `Agent '${record.name}' uses skill '${skillName}', which allows tool '${tool}' that this ` +
        'agent does not have, so the session would never offer it. Add it to the agent, or set ' +
        "an allowedTools override on the agent's skill entry.",
      'SKILL_TOOL_NOT_AVAILABLE',
    );
  }
}

/**
 * The record narrows the model provider's budget; it cannot widen it. The
 * provider record's `contextWindow` is a property of the model itself, so an
 * agent allowed to exceed it would fail on the first full context instead of at
 * resolution.
 */
function resolveLimits(record: AgentRecord, modelProvider: ModelProviderRecord): AgentLimits {
  const { contextWindow, maxOutputTokens: providerOutput } = modelProvider.capabilities;
  const maxOutputTokens = record.limits.maxOutputTokens ?? providerOutput;
  // The input budget is what the window leaves once the reply is reserved, so a
  // full context plus a full reply cannot exceed `contextWindow`.
  const maxInputTokens = record.limits.maxInputTokens ?? contextWindow - maxOutputTokens;
  if (maxOutputTokens > providerOutput) {
    throw new AgentHarnessError(
      `Agent '${record.name}' sets limits.maxOutputTokens ${maxOutputTokens}, above the ` +
        `${providerOutput} its model provider '${modelProvider.name}' allows.`,
      'AGENT_LIMIT_EXCEEDS_MODEL',
    );
  }
  if (maxInputTokens + maxOutputTokens > contextWindow) {
    throw new AgentHarnessError(
      `Agent '${record.name}' sets limits.maxInputTokens ${maxInputTokens} with ` +
        `maxOutputTokens ${maxOutputTokens}, above the ${contextWindow} context window of its ` +
        `model provider '${modelProvider.name}'.`,
      'AGENT_LIMIT_EXCEEDS_MODEL',
    );
  }
  return { maxTurns: record.limits.maxTurns, maxOutputTokens, maxInputTokens };
}

/** Records with `capabilities.tools` false contribute none. */
async function mcpTools(
  records: readonly McpServerRecord[],
  connections: readonly McpConnection[],
): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const [index, connection] of connections.entries()) {
    if (records[index]?.capabilities.tools !== true) continue;
    tools.push(...(await connection.tools()));
  }
  return tools;
}

async function closeAll(connections: readonly McpConnection[]): Promise<void> {
  await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
}
