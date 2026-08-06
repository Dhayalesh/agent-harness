import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentHarnessError } from '../core/errors.js';
import type { McpConnectionOptions, McpElicitationHandler } from '../mcp/client.js';
import { McpConnection } from '../mcp/client.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import type { McpServerRecord } from './mcp-server-definitions.js';
import { assertMcpRuntimeSupport } from './mcp-server-support.js';

/** The read surface the registry needs; satisfied by `MongoMcpServerStore`. */
export interface McpServerLookup {
  get(id: string): Promise<McpServerRecord | undefined>;
  getByName(name: string): Promise<McpServerRecord | undefined>;
  listAutoConnect(): Promise<McpServerRecord[]>;
}

export type PlatformMcpServerRegistryOptions = {
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
  logSink?: LogSink;
  logContext?: LogContext;
  /**
   * Answers a server's `elicitation/create`. Records that ask for elicitation
   * without one resolve anyway, with the capability left unadvertised: a server
   * cannot prompt a host that has no way to ask.
   */
  elicitationHandler?: McpElicitationHandler;
};

/**
 * Turns `mcp_servers` records into live connections. Named for symmetry with
 * `PlatformModelProviderRegistry`, and separate from `ToolRegistry`
 * (`src/tools/registry.ts`), which holds the tools a session can call.
 */
export class PlatformMcpServerRegistry {
  private readonly logger: (message: string) => void;

  constructor(
    private readonly store: McpServerLookup,
    private readonly options: PlatformMcpServerRegistryOptions = {},
  ) {
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  async resolveById(id: string): Promise<McpConnection> {
    const record = await this.store.get(id);
    if (!record) {
      throw new AgentHarnessError(`Unknown MCP server: ${id}`, 'MCP_SERVER_NOT_FOUND');
    }
    return this.resolveRecord(record);
  }

  async resolveByName(name: string): Promise<McpConnection> {
    const record = await this.store.getByName(name);
    if (!record) {
      throw new AgentHarnessError(`Unknown MCP server: ${name}`, 'MCP_SERVER_NOT_FOUND');
    }
    return this.resolveRecord(record);
  }

  /**
   * Connects every record a run picks up by default. An empty set is a valid
   * answer: MCP is additive, so no records means no MCP tools rather than a
   * failed run. One record that cannot connect fails the whole call, and the
   * connections already opened are closed before the error leaves.
   */
  async resolveAutoConnect(): Promise<McpConnection[]> {
    const records = await this.store.listAutoConnect();
    return this.resolveRecords(records);
  }

  async resolveRecords(records: readonly McpServerRecord[]): Promise<McpConnection[]> {
    const connections: McpConnection[] = [];
    try {
      for (const record of records) {
        connections.push(await this.resolveRecord(record));
      }
      return connections;
    } catch (error) {
      await closeAll(connections);
      throw error;
    }
  }

  async resolveRecord(record: McpServerRecord): Promise<McpConnection> {
    // Defence in depth: a record may predate a change to MCP_RUNTIME_SUPPORT.
    assertMcpRuntimeSupport(record);
    if (!record.enabled) {
      throw new AgentHarnessError(`MCP server is disabled: ${record.name}`, 'MCP_SERVER_DISABLED');
    }

    const options = this.connectionOptions(record);
    if (record.transport === 'stdio') {
      return McpConnection.connectStdio(record.name, stdioParameters(record), options);
    }
    if (!record.url) {
      throw new AgentHarnessError(
        `MCP server requires url: ${record.name}`,
        'MCP_SERVER_URL_MISSING',
      );
    }
    const url = new URL(record.url);
    assertUsableUrl(url);
    return McpConnection.connectHttp(record.name, url, httpTransportOptions(record), options);
  }

  /**
   * Elicitation is the one capability that needs something from the host, so a
   * record that asks for it without a handler is reported rather than silently
   * downgraded.
   */
  private connectionOptions(record: McpServerRecord): McpConnectionOptions {
    const handler = this.options.elicitationHandler;
    if (record.capabilities.elicitation && handler === undefined) {
      const message =
        `[mcp-server-registry] stored capability 'elicitation' for '${record.name}' is not in ` +
        'effect: no elicitationHandler was supplied, so the capability stays unadvertised ' +
        'and the server cannot prompt (src/mcp/client.ts).';
      this.logger(message);
      emitLog(this.options.logSink, {
        ...(this.options.logContext ?? {}),
        level: 'warn',
        event: 'mcp.configuration.warning',
        serverName: record.name,
        message,
      });
    }
    return {
      ...(record.capabilities.elicitation && handler !== undefined
        ? { elicitationHandler: handler }
        : {}),
      connectTimeoutMs: record.capabilities.connectTimeoutMs,
      requestTimeoutMs: record.capabilities.requestTimeoutMs,
      ...(this.options.logSink === undefined ? {} : { logSink: this.options.logSink }),
      ...(this.options.logContext === undefined ? {} : { logContext: this.options.logContext }),
    };
  }
}

/**
 * A stdio record spawns a process, so `command` is the whole trust boundary.
 *
 * `env` is merged over the SDK's inherited default rather than replacing it,
 * because `StdioClientTransport` passes a supplied `env` through verbatim: a
 * record naming one variable would otherwise start the child with only that one
 * and no `PATH`.
 */
function stdioParameters(record: McpServerRecord): StdioServerParameters {
  if (!record.command) {
    throw new AgentHarnessError(
      `MCP server requires command: ${record.name}`,
      'MCP_SERVER_COMMAND_MISSING',
    );
  }
  return {
    command: record.command,
    ...(record.args === undefined ? {} : { args: [...record.args] }),
    ...(record.env === undefined ? {} : { env: { ...getDefaultEnvironment(), ...record.env } }),
    ...(record.wire?.stderr === undefined ? {} : { stderr: record.wire.stderr }),
    ...(record.wire?.cwd === undefined ? {} : { cwd: record.wire.cwd }),
  };
}

function httpTransportOptions(record: McpServerRecord): StreamableHTTPClientTransportOptions {
  const headers = { ...record.headers, ...authHeader(record) };
  return {
    ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
    ...(record.wire?.sessionId === undefined ? {} : { sessionId: record.wire.sessionId }),
  };
}

/** The credential is on the record; there is nowhere else left to look. */
function authHeader(record: McpServerRecord): Record<string, string> {
  if (record.auth.kind === 'none') return {};
  if (!record.apiKey) {
    throw new AgentHarnessError(
      `MCP server requires apiKey: ${record.name}`,
      'MISSING_MCP_CREDENTIAL',
    );
  }
  if (record.auth.kind === 'bearer') return { Authorization: `Bearer ${record.apiKey}` };
  if (!record.auth.headerName) {
    throw new AgentHarnessError(
      `MCP server requires auth.headerName: ${record.name}`,
      'MCP_SERVER_AUTH_HEADER_MISSING',
    );
  }
  return { [record.auth.headerName]: record.apiKey };
}

/**
 * No allowlist backs the endpoint, so the record is trusted as written: whoever
 * can write `url` decides where `apiKey` is sent. The one remaining check is that
 * the URL cannot carry credentials of its own, which would smuggle a second
 * secret past the record.
 */
function assertUsableUrl(url: URL): void {
  if (url.username || url.password) {
    throw new AgentHarnessError(
      'MCP server url cannot contain credentials',
      'MCP_SERVER_URL_INVALID',
    );
  }
}

async function closeAll(connections: readonly McpConnection[]): Promise<void> {
  await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
}
