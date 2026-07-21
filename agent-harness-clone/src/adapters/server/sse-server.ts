import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentSession } from '../../core/agent-session.js';

export type AgentServerOptions = {
  createSession(): AgentSession | Promise<AgentSession>;
  host?: string;
  port?: number;
  authenticate?: (request: IncomingMessage) => boolean | Promise<boolean>;
};

export type RunningAgentServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function startAgentSseServer(
  options: AgentServerOptions,
): Promise<RunningAgentServer> {
  const server = createServer(async (request, response) => {
    try {
      if (options.authenticate && !(await options.authenticate(request))) {
        json(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/sessions/run') {
        json(response, 404, { error: 'Not found' });
        return;
      }

      const body = await readJson(request);
      if (!body || typeof body !== 'object' || typeof body.prompt !== 'string') {
        json(response, 400, { error: 'Body must contain a string prompt' });
        return;
      }

      const session = await options.createSession();
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      request.once('close', () => session.interrupt('client disconnected'));
      for await (const event of session.run({ prompt: body.prompt })) {
        response.write(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      await session.close();
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');
  const host = options.host ?? '127.0.0.1';
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
