import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
};

export class McpConnection {
  private constructor(
    readonly serverName: string,
    private readonly client: Client,
    private readonly transport: { close(): Promise<void> },
  ) {}

  static async connectStdio(
    serverName: string,
    parameters: StdioServerParameters,
    options: McpConnectionOptions = {},
  ): Promise<McpConnection> {
    const client = createClient(options);
    const transport = new StdioClientTransport(parameters);
    await client.connect(transport);
    return new McpConnection(serverName, client, transport);
  }

  static async connectHttp(
    serverName: string,
    url: URL,
    transportOptions: StreamableHTTPClientTransportOptions = {},
    options: McpConnectionOptions = {},
  ): Promise<McpConnection> {
    const client = createClient(options);
    const transport = new StreamableHTTPClientTransport(url, transportOptions);
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    return new McpConnection(serverName, client, transport);
  }

  async tools(): Promise<Tool[]> {
    const discovered = await this.client.listTools();
    return discovered.tools.map((remote): Tool<Record<string, unknown>> => ({
      name: `mcp__${normalize(this.serverName)}__${normalize(remote.name)}`,
      description: remote.description ?? `MCP tool ${remote.name} from ${this.serverName}`,
      inputSchema: z.record(z.string(), z.unknown()),
      jsonSchema: remote.inputSchema,
      kind: remote.annotations?.readOnlyHint ? 'read' : 'network',
      concurrencySafe: remote.annotations?.readOnlyHint ?? false,
      destructive: remote.annotations?.destructiveHint ?? false,
      execute: async (input, context) => {
        const result = await this.client.callTool(
          { name: remote.name, arguments: input },
          undefined,
          { signal: context.signal },
        );
        return {
          content: formatMcpContent(result.content),
          metadata: {
            server: this.serverName,
            remoteTool: remote.name,
            isError: result.isError ?? false,
            structuredContent: result.structuredContent,
            _meta: result._meta,
          },
        };
      },
    }));
  }

  async listResources(): Promise<McpResource[]> {
    const response = await this.client.listResources();
    return response.resources.map((resource) => ({
      server: this.serverName,
      uri: resource.uri,
      name: resource.name,
      ...(resource.description === undefined ? {} : { description: resource.description }),
      ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    const response = await this.client.readResource(
      { uri },
      signal === undefined ? undefined : { signal },
    );
    return response.contents.map((content) => ({
      uri: content.uri,
      ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
      ...('text' in content ? { text: content.text } : { blob: content.blob }),
    }));
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const response = await this.client.listPrompts();
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
    const response = await this.client.getPrompt(
      { name, arguments: args },
      signal === undefined ? undefined : { signal },
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
    await this.client.close();
    await this.transport.close().catch(() => undefined);
  }
}

function createClient(options: McpConnectionOptions): Client {
  const client = new Client(
    { name: 'agent-harness', version: '0.1.0' },
    {
      capabilities:
        options.elicitationHandler === undefined ? {} : { elicitation: { form: {}, url: {} } },
    },
  );
  const elicitationHandler = options.elicitationHandler;
  if (elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      elicitationHandler(request.params),
    );
  }
  return client;
}

function normalize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
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
