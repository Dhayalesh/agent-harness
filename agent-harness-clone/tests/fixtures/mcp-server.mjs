import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool(
  'echo',
  {
    description: 'Echo text',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);
server.registerTool(
  'ask',
  {
    description: 'Ask the MCP client for input',
    inputSchema: {},
  },
  async () => {
    const response = await server.server.elicitInput({
      mode: 'form',
      message: 'Confirm fixture',
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
    return {
      content: [
        {
          type: 'text',
          text: response.action === 'accept' ? String(response.content?.answer) : response.action,
        },
      ],
    };
  },
);
server.registerResource(
  'fixture-resource',
  'fixture://hello',
  { description: 'Fixture resource', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'resource contents' }] }),
);
server.registerPrompt(
  'greeting',
  {
    description: 'Build a greeting',
    argsSchema: { name: z.string() },
  },
  async ({ name }) => ({
    description: 'A generated greeting',
    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
  }),
);
await server.connect(new StdioServerTransport());
