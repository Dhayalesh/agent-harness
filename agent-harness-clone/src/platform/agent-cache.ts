import { MongoClient } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import type { Tool } from '../tools/tool.js';
import type { AgentEnvironmentConfig } from './agent-resolution.js';
import { agentConfigFromEnvironment } from './agent-resolution.js';
import type { PlatformAgentRegistryOptions, ResolvedAgent } from './agent-registry.js';
import { PlatformAgentRegistry } from './agent-registry.js';
import { MongoAgentStore } from './agent-store.js';
import { MongoMcpServerStore } from './mcp-server-store.js';
import { MongoModelProviderStore, PLATFORM_MONGO_APP_NAME } from './model-provider-store.js';
import { MongoSkillStore } from './skill-store.js';

export type AgentCacheOptions = PlatformAgentRegistryOptions & {
  /**
   * Injected in tests, so the cache can be exercised without a Mongo client.
   * Production leaves it unset and the cache builds the four stores itself.
   */
  resolve?: (agentName: string) => Promise<ResolvedAgent>;
  /**
   * Names the record `isDefault` would have named. Paired with `resolve`, and for
   * the same reason: resolving an agent only to read its name back would download
   * every skill it references to answer a question the collection can answer.
   */
  defaultAgentName?: () => Promise<string>;
};

/**
 * Resolves stored agents once per name and keeps them for the life of the process.
 *
 * `resolveAgentFromDatabase` is built for a command: it opens a Mongo client,
 * assembles one agent, and closes everything when the command ends. A long-lived
 * host serving many sessions cannot use it per session, because assembling an
 * agent downloads every skill document from S3 and completes an `initialize`
 * handshake with every MCP server it references. Paying that per session would
 * put a bucket round trip and a process spawn in front of every prompt.
 *
 * So agents are cached by `agents.name`, and the entries are closed at shutdown
 * rather than per session. This is the same trade the agent-core service already
 * makes for MCP, which connects its servers once at startup and shares them
 * across sessions; the difference is only that the set of agents is discovered as
 * callers ask for them instead of being fixed before the listener opens.
 *
 * What that costs: a record edited in Mongo is not picked up until the process
 * restarts. Editing an agent is an operator action taken through `scripts/`, and
 * a run that changed its own prompt or tool list halfway through a conversation
 * would be harder to reason about than one that did not, so the stale read is the
 * safer of the two. Restart the runtime to pick up an edit.
 */
export class AgentCache {
  private readonly entries = new Map<string, Promise<ResolvedAgent>>();
  private readonly client: MongoClient | undefined;
  private readonly registry: PlatformAgentRegistry | undefined;
  private readonly agents: MongoAgentStore | undefined;
  private readonly resolveOverride: ((agentName: string) => Promise<ResolvedAgent>) | undefined;
  private readonly defaultNameOverride: (() => Promise<string>) | undefined;
  private closing = false;

  constructor(
    config: AgentEnvironmentConfig = agentConfigFromEnvironment(),
    options: AgentCacheOptions = {},
  ) {
    const { resolve, defaultAgentName, ...registryOptions } = options;
    this.resolveOverride = resolve;
    this.defaultNameOverride = defaultAgentName;
    if (resolve !== undefined) return;

    // One client for all four collections and every agent, rather than the one
    // per resolution `resolveAgentFromDatabase` opens: the connection outlives
    // any single lookup here.
    const client = new MongoClient(config.uri, { appName: PLATFORM_MONGO_APP_NAME });
    const databaseName = config.databaseName;
    const agents = new MongoAgentStore({ client, databaseName });
    this.client = client;
    this.agents = agents;
    this.registry = new PlatformAgentRegistry(
      {
        agents,
        modelProviders: new MongoModelProviderStore({ client, databaseName }),
        skills: new MongoSkillStore({ client, databaseName }),
        mcpServers: new MongoMcpServerStore({ client, databaseName }),
      },
      registryOptions,
    );
  }

  /** Opens the Mongo connection the lookups share. A no-op when `resolve` was injected. */
  async connect(): Promise<void> {
    await this.client?.connect();
  }

  /**
   * The agent under `agentName`, or the record marked `isDefault` when it is unset.
   *
   * Two sessions naming the same agent at the same moment share one resolution:
   * the promise is stored before it settles, so the second caller awaits the first
   * rather than spawning a second copy of every MCP server the record references.
   * A rejected resolution is evicted, so a caller retrying after fixing the record
   * is not served the earlier failure forever.
   */
  async get(agentName?: string): Promise<ResolvedAgent> {
    if (this.closing) {
      throw new AgentHarnessError('Agent cache is closing', 'AGENT_CACHE_CLOSED');
    }
    // The default is read on every call rather than cached under a placeholder
    // key, so moving `isDefault` to another record takes effect on the next
    // session instead of at the next restart. The read is one indexed query, and
    // the assembled agent behind the name it resolves to is still shared.
    const name = agentName ?? (await this.defaultAgentName());
    const existing = this.entries.get(name);
    if (existing) return existing;

    const pending = this.resolveByName(name);
    this.entries.set(name, pending);
    return pending.catch((error: unknown) => {
      if (this.entries.get(name) === pending) this.entries.delete(name);
      throw error;
    });
  }

  /**
   * Closes every agent that was resolved, which closes their MCP connections and
   * deletes their temporary skill directories, then releases the Mongo client.
   *
   * Failures are collected rather than thrown one at a time: a server shutting
   * down should release every agent it holds even when one of them will not close
   * cleanly.
   */
  async close(): Promise<void> {
    this.closing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        await (await entry).close();
      } catch (error) {
        failures.push(error);
      }
    }
    await this.client?.close();
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to close ${failures.length} cached agent(s)`);
    }
  }

  private async resolveByName(name: string): Promise<ResolvedAgent> {
    if (this.resolveOverride) return this.resolveOverride(name);
    if (!this.registry) throw new AgentHarnessError('Agent cache has no registry', 'AGENT_CACHE');
    return this.registry.resolveByName(name);
  }

  private async defaultAgentName(): Promise<string> {
    if (this.defaultNameOverride) return this.defaultNameOverride();
    if (!this.agents) throw new AgentHarnessError('Agent cache has no registry', 'AGENT_CACHE');
    const record = await this.agents.getDefault();
    if (!record) {
      throw new AgentHarnessError(
        'No enabled agent is marked isDefault, and the caller named none. Name an agent in the ' +
          'invocation payload, or set isDefault with npx tsx scripts/agent/editAgent.ts.',
        'AGENT_NOT_FOUND',
      );
    }
    return record.name;
  }
}

/**
 * Swaps the host-bound tools in a resolved agent for this session's own.
 *
 * A resolved agent is shared between sessions, but its local tools are not
 * shareable: each is built against one `RuntimeHost`, and a hosted runtime gives
 * every session its own workspace root, so reusing the instances would point
 * every session's `read_file` and `bash` at one directory. The MCP tools and the
 * `skill` tool are host-independent and pass through untouched.
 *
 * Matching by name rather than by position keeps the order the registry
 * established — the record's local tools, then `skill`, then the namespaced MCP
 * tools — without restating how that list was built.
 */
export function rebindLocalTools(
  tools: readonly Tool[],
  sessionTools: readonly Tool[],
): readonly Tool[] {
  const bySessionName = new Map(sessionTools.map((tool) => [tool.name, tool]));
  return tools.map((tool) => bySessionName.get(tool.name) ?? tool);
}
