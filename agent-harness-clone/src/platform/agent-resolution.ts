import { MongoClient } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import type { PlatformAgentRegistryOptions, ResolvedAgent } from './agent-registry.js';
import { PlatformAgentRegistry } from './agent-registry.js';
import { MongoAgentStore } from './agent-store.js';

import { MongoMcpServerStore } from './mcp-server-store.js';
// The database location is one setting for the whole platform, so the parser is
// shared with `model_providers` rather than restated here.
import { databaseNameFromUri } from './model-provider-resolution.js';
import { MongoModelProviderStore, PLATFORM_MONGO_APP_NAME } from './model-provider-store.js';
import { MongoSkillStore } from './skill-store.js';

/**
 * Where the runnable entrypoints look for their agents. The database is the only
 * source, and its location is the only thing the environment contributes.
 *
 * There is no environment-supplied agent either: unlike `model_providers`, which
 * has `PLATFORM_MODEL_PROVIDER`, no variable names a record here. An agent
 * carries a system prompt, a tool list, and a set of skills, so a variable that
 * could switch it would let a stray value change what a run is allowed to do
 * without touching the database. Which record runs is therefore either asked for
 * by the caller (`AgentResolutionOptions.agentName`) or taken from the record
 * marked `isDefault`, and both of those live in the collection.
 */
export type AgentEnvironmentConfig = {
  uri: string;
  databaseName: string;
};

export function agentConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AgentEnvironmentConfig {
  const uri = required(environment, 'PLATFORM_MONGODB_URI');
  return { uri, databaseName: databaseNameFromUri(uri) };
}

export type AgentResolutionOptions = PlatformAgentRegistryOptions & {
  /**
   * Record `name`. Unset selects the record marked `isDefault`.
   *
   * This is a caller's request, not configuration, which is why it sits here and
   * not on `AgentEnvironmentConfig`: a CLI flag or an API field can name an
   * agent, the environment cannot.
   */
  agentName?: string;
};

export type ResolvedAgentFromDatabase = ResolvedAgent & {
  /**
   * Closes every MCP connection, deletes the temporary skill directory, then
   * releases the Mongo connection opened for the lookups.
   */
  close(): Promise<void>;
};

/**
 * Reads one `agents` record and assembles what it describes: the model provider it
 * references, its stored system prompt, the `skills` records it references with their
 * documents downloaded from their buckets to a temporary directory, the MCP servers
 * it references, and its tool selection.
 *
 * The returned `close` removes that directory as well as closing the connections, so
 * the caller must run it in a `finally`.
 *
 * Five stores are built because the record is deliberately a set of references: the
 * agent says *which* model, *which* skills, and *which* servers, and the credentials
 * stay in their own collections. That keeps `agents` free of secrets and lets one key
 * rotation reach every agent that points at it. All five collections live in the same
 * database, so they share one client rather than opening five.
 */
export async function resolveAgentFromDatabase(
  config: AgentEnvironmentConfig = agentConfigFromEnvironment(),
  options: AgentResolutionOptions = {},
): Promise<ResolvedAgentFromDatabase> {
  const { agentName, ...registryOptions } = options;
  const client = new MongoClient(config.uri, { appName: PLATFORM_MONGO_APP_NAME });
  await client.connect();
  // `closeClient` is left false on all three: the client is owned here, and the
  // returned `close` releases it once, after the connections are down.
  const agents = new MongoAgentStore({ client, databaseName: config.databaseName });
  const stores = {
    agents,
    modelProviders: new MongoModelProviderStore({ client, databaseName: config.databaseName }),
    skills: new MongoSkillStore({ client, databaseName: config.databaseName }),

    mcpServers: new MongoMcpServerStore({ client, databaseName: config.databaseName }),
  };
  try {
    const record =
      agentName === undefined ? await agents.getDefault() : await agents.getByName(agentName);
    if (!record) throw await notFound(agents, config.databaseName, agentName);
    const resolved = await new PlatformAgentRegistry(stores, registryOptions).resolveRecord(record);
    return {
      ...resolved,
      close: async () => {
        await resolved.close();
        await client.close();
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * Lists what is there, because the two ways to miss look identical from the
 * outside: an empty collection and a misspelled name both read as "no agent".
 */
async function notFound(
  agents: MongoAgentStore,
  databaseName: string,
  agentName: string | undefined,
): Promise<AgentHarnessError> {
  const available = (await agents.list({ enabledOnly: true })).map((record) => record.name);
  const known =
    available.length === 0
      ? `${databaseName}.agents holds no enabled record. Add one with npx tsx scripts/agent/seedAgent.ts.`
      : `Enabled records: ${available.join(', ')}.`;
  return new AgentHarnessError(
    (agentName === undefined
      ? `No enabled agent in ${databaseName}.agents is marked isDefault. ` +
        'Name one explicitly, or set isDefault with npx tsx scripts/agent/editAgent.ts. '
      : `Unknown agent '${agentName}' in ${databaseName}.agents. `) + known,
    'AGENT_NOT_FOUND',
  );
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AgentHarnessError(
      `${name} is required: agents are read from the database only`,
      'AGENT_CONFIG_MISSING',
    );
  }
  return value;
}
