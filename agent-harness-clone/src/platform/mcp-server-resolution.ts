import { AgentHarnessError } from '../core/errors.js';
import type { McpConnection } from '../mcp/client.js';
import type { Tool } from '../tools/tool.js';
import type { McpServerRecord } from './mcp-server-definitions.js';
import type { PlatformMcpServerRegistryOptions } from './mcp-server-registry.js';
import { PlatformMcpServerRegistry } from './mcp-server-registry.js';
import { MongoMcpServerStore } from './mcp-server-store.js';
// The database location is one setting for the whole platform, so the parser is
// shared with `model_providers` rather than restated here.
import { databaseNameFromUri } from './model-provider-resolution.js';

/**
 * Where the runnable entrypoints look for their MCP servers. The database is the
 * only source, and the location of that database is the only thing the
 * environment contributes.
 *
 * There is no environment-supplied command, url, or credential, and no local
 * server file: a stray variable cannot attach an unreviewed server to a run.
 * Which records a run uses is stored too, on `autoConnect`, so the selection
 * cannot be overridden from outside the database either. Change it with
 * `scripts/mcp/editMcp.js`.
 */
export type McpServerEnvironmentConfig = {
  uri: string;
  databaseName: string;
};

export function mcpServerConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): McpServerEnvironmentConfig {
  const uri = required(environment, 'PLATFORM_MONGODB_URI');
  return { uri, databaseName: databaseNameFromUri(uri) };
}

export type ResolvedMcpServers = {
  connections: readonly McpConnection[];
  records: readonly McpServerRecord[];
  /**
   * Every discovered tool, already named `mcp__<server>__<tool>`, ready to hand
   * to `createAgentSession`. Records with `capabilities.tools` false contribute
   * none.
   */
  tools: readonly Tool[];
  /** Closes every connection, then the Mongo connection opened for the lookup. */
  close(): Promise<void>;
};

/**
 * Reads every enabled `autoConnect` record and connects the servers they
 * describe. Each record carries the transport, the endpoint or command, and the
 * credential, so those documents are the whole configuration and the whole trust
 * boundary.
 *
 * Resolving nothing is a valid outcome. MCP tools are additive, so a collection
 * with no `autoConnect` record leaves a run with its builtin tools instead of
 * failing it.
 */
export async function resolveMcpServersFromDatabase(
  config: McpServerEnvironmentConfig = mcpServerConfigFromEnvironment(),
  options: PlatformMcpServerRegistryOptions = {},
): Promise<ResolvedMcpServers> {
  const store = await MongoMcpServerStore.connect(config.uri, config.databaseName);
  try {
    const records = await store.listAutoConnect();
    const connections = await new PlatformMcpServerRegistry(store, options).resolveRecords(records);
    try {
      const tools: Tool[] = [];
      for (const [index, connection] of connections.entries()) {
        if (records[index]?.capabilities.tools !== true) continue;
        tools.push(...(await connection.tools()));
      }
      return {
        connections,
        records,
        tools,
        close: async () => {
          await Promise.all(
            connections.map((connection) => connection.close().catch(() => undefined)),
          );
          await store.close();
        },
      };
    } catch (error) {
      await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
      throw error;
    }
  } catch (error) {
    await store.close();
    throw error;
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AgentHarnessError(
      `${name} is required: MCP servers are read from the database only`,
      'MCP_SERVER_CONFIG_MISSING',
    );
  }
  return value;
}
