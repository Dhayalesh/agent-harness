import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool } from '../tools/tool.js';

export type HarnessMcpServerOptions = {
  name?: string;
  version?: string;
  tools: readonly Tool[];
  workingDirectory: string;
};

export function createHarnessMcpServer(options: HarnessMcpServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? 'agent-harness-tools',
    version: options.version ?? '0.1.0',
  });
  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.kind === 'read',
          destructiveHint: tool.destructive ?? false,
          openWorldHint: tool.kind === 'network',
        },
      },
      async (input, extra) => {
        try {
          const result = await tool.execute(input, {
            sessionId: extra.sessionId ?? 'mcp',
            turnId: randomUUID(),
            toolCallId: randomUUID(),
            workingDirectory: options.workingDirectory,
            signal: extra.signal,
            messages: [],
            reportProgress() {},
          });
          return {
            content: [{ type: 'text' as const, text: result.content }],
            ...(result.metadata === undefined ? {} : { structuredContent: result.metadata }),
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

export async function runHarnessMcpStdioServer(options: HarnessMcpServerOptions): Promise<void> {
  const server = createHarnessMcpServer(options);
  await server.connect(new StdioServerTransport());
}
