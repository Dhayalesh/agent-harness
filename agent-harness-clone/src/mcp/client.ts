import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import type { Tool } from '../tools/tool.js';

export type McpResource = {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

export type McpPrompt = {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptResult = {
  description?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;
};

export type McpElicitationHandler = (
  request: ElicitRequest['params'],
) => ElicitResult | Promise<ElicitResult>;

export type McpConnectionOptions = {
  elicitationHandler?: McpElicitationHandler;
  /** Budget for the `initialize` handshake. Unset leaves the SDK default. */
  connectTimeoutMs?: number;
  /** Budget for every request after it. Unset leaves the SDK default. */
  requestTimeoutMs?: number;
  /** Receives connection, discovery, request, call, and close lifecycle records. */
  logSink?: LogSink;
  /** Correlation fields copied onto every MCP lifecycle record. */
  logContext?: LogContext;
};

export class McpConnection {
  private constructor(
    readonly serverName: string,
    private readonly client: Client,
    private readonly transport: { close(): Promise<void> },
    private readonly requestTimeoutMs?: number,
    private readonly logSink?: LogSink,
    private readonly logContext: LogContext = {},
  ) {}

  static async connectStdio(
    serverName: string,
    parameters: StdioServerParameters,
    options: McpConnectionOptions = {},
  ): Promise<McpConnection> {
    const started = Date.now();
    emitMcp(options, {
      event: 'mcp.connection.started',
      serverName,
      transport: 'stdio',
    });
    emitMcp(options, {
      level: 'debug',
      event: 'mcp.connection.details',
      serverName,
      transport: 'stdio',
      command: parameters.command,
      args: parameters.args ?? [],
    });
    const client = createClient(serverName, options);
    const transport = new StdioClientTransport(parameters);
    try {
      await client.connect(transport, timeoutOptions(options.connectTimeoutMs));
      emitMcp(options, {
        event: 'mcp.connection.completed',
        serverName,
        transport: 'stdio',
        durationMs: Date.now() - started,
      });
      return new McpConnection(
        serverName,
        client,
        transport,
        options.requestTimeoutMs,
        options.logSink,
        options.logContext,
      );
    } catch (error) {
      emitMcp(options, {
        level: 'error',
        event: 'mcp.connection.failed',
        serverName,
        transport: 'stdio',
        durationMs: Date.now() - started,
        error: describeError(error),
      });
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  static async connectHttp(
    serverName: string,
    url: URL,
    transportOptions: StreamableHTTPClientTransportOptions = {},
    options: McpConnectionOptions = {},
  ): Promise<McpConnection> {
    const started = Date.now();
    emitMcp(options, {
      event: 'mcp.connection.started',
      serverName,
      transport: 'http',
    });
    emitMcp(options, {
      level: 'debug',
      event: 'mcp.connection.details',
      serverName,
      transport: 'http',
      url: url.toString(),
    });
    const client = createClient(serverName, options);
    const transport = new StreamableHTTPClientTransport(url, transportOptions);
    try {
      await client.connect(
        transport as unknown as Parameters<Client['connect']>[0],
        timeoutOptions(options.connectTimeoutMs),
      );
      emitMcp(options, {
        event: 'mcp.connection.completed',
        serverName,
        transport: 'http',
        durationMs: Date.now() - started,
      });
      return new McpConnection(
        serverName,
        client,
        transport,
        options.requestTimeoutMs,
        options.logSink,
        options.logContext,
      );
    } catch (error) {
      emitMcp(options, {
        level: 'error',
        event: 'mcp.connection.failed',
        serverName,
        transport: 'http',
        durationMs: Date.now() - started,
        error: describeError(error),
      });
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async tools(): Promise<Tool[]> {
    const discovered = await this.request('tools/list', {}, () =>
      this.client.listTools(undefined, this.requestOptions()),
    );
    const tools = discovered.tools.map((remote): Tool<Record<string, unknown>> => ({
      name: `mcp__${normalize(this.serverName)}__${normalize(remote.name)}`,
      description: remote.description ?? `MCP tool ${remote.name} from ${this.serverName}`,
      inputSchema: z.record(z.string(), z.unknown()),
      jsonSchema: remote.inputSchema,
      kind: remote.annotations?.readOnlyHint ? 'read' : 'network',
      concurrencySafe: remote.annotations?.readOnlyHint ?? false,
      destructive: remote.annotations?.destructiveHint ?? false,
      execute: async (input, context) => {
        const request = { name: remote.name, arguments: input };
        const result = await this.request(
          'tools/call',
          request,
          () =>
            this.client.callTool(request, undefined, {
              ...this.requestOptions(context.signal),
              // Supplying this is what makes the SDK send a progress token, which
              // is what makes a long remote tool report anything at all. Without
              // it an MCP call is opaque until it returns.
              onprogress: (progress) => {
                context.reportProgress(
                  progress.message ?? `${remote.name}: ${describeProgress(progress)}`,
                  {
                    server: this.serverName,
                    remoteTool: remote.name,
                    progress: progress.progress,
                    ...(progress.total === undefined ? {} : { total: progress.total }),
                  },
                );
              },
            }),
          {
            toolCallId: context.toolCallId,
            turnId: context.turnId,
            sessionId: context.sessionId,
            remoteTool: remote.name,
          },
        );
        return {
          content: formatMcpContent(result.content),
          isError: result.isError === true,
          metadata: {
            server: this.serverName,
            remoteTool: remote.name,
            isError: result.isError === true,
            structuredContent: result.structuredContent,
            _meta: result._meta,
          },
        };
      },
    }));
    this.log({
      event: 'mcp.tools.discovered',
      serverName: this.serverName,
      toolCount: tools.length,
    });
    this.log({
      level: 'debug',
      event: 'mcp.tools.details',
      serverName: this.serverName,
      remoteTools: discovered.tools.map((tool) => tool.name),
      tools: tools.map((tool) => tool.name),
    });
    return tools;
  }

  async listResources(): Promise<McpResource[]> {
    const response = await this.request('resources/list', {}, () =>
      this.client.listResources(undefined, this.requestOptions()),
    );
    return response.resources.map((resource) => ({
      server: this.serverName,
      uri: resource.uri,
      name: resource.name,
      ...(resource.description === undefined ? {} : { description: resource.description }),
      ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    const request = { uri };
    const response = await this.request('resources/read', request, () =>
      this.client.readResource(request, this.requestOptions(signal)),
    );
    return response.contents.map((content) => ({
      uri: content.uri,
      ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
      ...('text' in content ? { text: content.text } : { blob: content.blob }),
    }));
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const response = await this.request('prompts/list', {}, () =>
      this.client.listPrompts(undefined, this.requestOptions()),
    );
    return response.prompts.map((prompt) => ({
      server: this.serverName,
      name: prompt.name,
      ...(prompt.description === undefined ? {} : { description: prompt.description }),
      ...(prompt.arguments === undefined
        ? {}
        : {
            arguments: prompt.arguments.map((argument) => ({
              name: argument.name,
              ...(argument.description === undefined ? {} : { description: argument.description }),
              ...(argument.required === undefined ? {} : { required: argument.required }),
            })),
          }),
    }));
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    const request = { name, arguments: args };
    const response = await this.request(
      'prompts/get',
      request,
      () => this.client.getPrompt(request, this.requestOptions(signal)),
      { promptName: name },
    );
    return {
      ...(response.description === undefined ? {} : { description: response.description }),
      messages: response.messages.map((message) => ({
        role: message.role,
        content: structuredClone(message.content),
      })),
    };
  }

  async close(): Promise<void> {
    const started = Date.now();
    this.log({ event: 'mcp.connection.close.started', serverName: this.serverName });
    try {
      await this.client.close();
      await this.transport.close().catch((error: unknown) => {
        this.log({
          level: 'warn',
          event: 'mcp.transport.close.failed',
          serverName: this.serverName,
          error: describeError(error),
        });
      });
      this.log({
        event: 'mcp.connection.close.completed',
        serverName: this.serverName,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      this.log({
        level: 'error',
        event: 'mcp.connection.close.failed',
        serverName: this.serverName,
        durationMs: Date.now() - started,
        error: describeError(error),
      });
      await this.transport.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Per-request options: the caller's cancellation signal plus the connection's
   * own budget. A caller that aborts still aborts; the budget only bounds a
   * server that never answers.
   */
  private requestOptions(signal?: AbortSignal): RequestOptions {
    return {
      ...(signal === undefined ? {} : { signal }),
      ...timeoutOptions(this.requestTimeoutMs),
    };
  }

  private async request<Result>(
    operation: string,
    request: unknown,
    run: () => Promise<Result>,
    fields: Record<string, unknown> = {},
  ): Promise<Result> {
    const started = Date.now();
    const mcpRequestId = randomUUID();
    this.log({
      event: 'mcp.request.started',
      serverName: this.serverName,
      operation,
      requestSummary: summarizeMcpValue(request),
      ...fields,
      mcpRequestId,
    });
    this.log({
      level: 'debug',
      event: 'mcp.request.input',
      serverName: this.serverName,
      operation,
      request,
      ...fields,
      mcpRequestId,
    });
    try {
      const response = await run();
      const remoteError =
        response !== null &&
        typeof response === 'object' &&
        'isError' in response &&
        response.isError === true;
      this.log({
        ...(remoteError ? { level: 'error' as const } : {}),
        event: 'mcp.request.completed',
        serverName: this.serverName,
        operation,
        remoteError,
        outcome: remoteError ? 'failure' : 'success',
        responseSummary: summarizeMcpValue(response),
        durationMs: Date.now() - started,
        ...fields,
        mcpRequestId,
      });
      this.log({
        level: 'debug',
        event: 'mcp.request.output',
        serverName: this.serverName,
        operation,
        request,
        response,
        remoteError,
        durationMs: Date.now() - started,
        ...fields,
        mcpRequestId,
      });
      return response;
    } catch (error) {
      this.log({
        level: 'error',
        event: 'mcp.request.failed',
        serverName: this.serverName,
        operation,
        outcome: 'failure',
        durationMs: Date.now() - started,
        error: describeError(error),
        ...fields,
        mcpRequestId,
      });
      this.log({
        level: 'debug',
        event: 'mcp.request.failure_details',
        serverName: this.serverName,
        operation,
        request,
        error: describeError(error),
        ...fields,
        mcpRequestId,
      });
      throw error;
    }
  }

  private log(entry: Parameters<LogSink['log']>[0]): void {
    emitLog(this.logSink, { ...this.logContext, ...entry });
  }
}

function summarizeMcpValue(value: unknown): Record<string, unknown> {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  let bytes: number | undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) bytes = Buffer.byteLength(serialized, 'utf8');
  } catch {
    // Logging a summary must never make an MCP request fail.
  }

  if (value === null || typeof value !== 'object') {
    return { type, ...(bytes === undefined ? {} : { bytes }) };
  }
  try {
    const record = value as Record<string, unknown>;
    const collection = ['tools', 'resources', 'prompts', 'content', 'messages']
      .map((key) => ({ key, value: record[key] }))
      .find((candidate) => Array.isArray(candidate.value));
    const items = collection?.value as unknown[] | undefined;
    const itemNames = items
      ?.map((item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string'
          ? (item as { name: string }).name
          : undefined,
      )
      .filter((name): name is string => name !== undefined);
    return {
      type,
      ...(bytes === undefined ? {} : { bytes }),
      keys: Object.keys(record).sort(),
      ...(collection === undefined
        ? {}
        : {
            collection: collection.key,
            itemCount: items?.length ?? 0,
            ...(itemNames && itemNames.length > 0 ? { itemNames } : {}),
          }),
    };
  } catch {
    // Request/response introspection is diagnostic only and must never alter MCP behavior.
    return { type, ...(bytes === undefined ? {} : { bytes }), unreadable: true };
  }
}

function timeoutOptions(timeout: number | undefined): RequestOptions {
  return timeout === undefined ? {} : { timeout };
}

function createClient(serverName: string, options: McpConnectionOptions): Client {
  const client = new Client(
    { name: 'agent-harness', version: '0.1.0' },
    {
      capabilities:
        options.elicitationHandler === undefined ? {} : { elicitation: { form: {}, url: {} } },
    },
  );
  const elicitationHandler = options.elicitationHandler;
  if (elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const started = Date.now();
      emitMcp(options, {
        event: 'mcp.elicitation.started',
        serverName,
        requestSummary: summarizeMcpValue(request.params),
      });
      emitMcp(options, {
        level: 'debug',
        event: 'mcp.elicitation.input',
        serverName,
        request: request.params,
      });
      try {
        const response = await elicitationHandler(request.params);
        emitMcp(options, {
          event: 'mcp.elicitation.completed',
          serverName,
          responseSummary: summarizeMcpValue(response),
          durationMs: Date.now() - started,
        });
        emitMcp(options, {
          level: 'debug',
          event: 'mcp.elicitation.output',
          serverName,
          request: request.params,
          response,
          durationMs: Date.now() - started,
        });
        return response;
      } catch (error) {
        emitMcp(options, {
          level: 'error',
          event: 'mcp.elicitation.failed',
          serverName,
          durationMs: Date.now() - started,
          error: describeError(error),
        });
        emitMcp(options, {
          level: 'debug',
          event: 'mcp.elicitation.failure_details',
          serverName,
          request: request.params,
          error: describeError(error),
        });
        throw error;
      }
    });
  }
  return client;
}

function emitMcp(options: McpConnectionOptions, entry: Parameters<LogSink['log']>[0]): void {
  emitLog(options.logSink, { ...(options.logContext ?? {}), ...entry });
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

function normalize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Fallback text for a server that sends counters without a message. `total` is
 * optional in the protocol, so an unbounded progress reads as a count rather than
 * as a percentage of an unknown whole.
 */
function describeProgress(progress: { progress: number; total?: number | undefined }): string {
  return progress.total === undefined
    ? `${progress.progress}`
    : `${progress.progress}/${progress.total}`;
}

function formatMcpContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object' || !('type' in block)) return JSON.stringify(block);
      const value = block as Record<string, unknown>;
      if (value.type === 'text') return String(value.text ?? '');
      if (value.type === 'resource') return JSON.stringify(value.resource);
      if (value.type === 'image' || value.type === 'audio') {
        return `[${String(value.type)} ${String(value.mimeType ?? '')}]`;
      }
      return JSON.stringify(value);
    })
    .join('\n');
}
