import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionGateway } from '../../gateway/session-gateway.js';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';

export type GatewayServerOptions = {
  gateway: SessionGateway;
  authenticate(request: IncomingMessage): string | Promise<string>;
  host?: string;
  port?: number;
  artifactStore?: ArtifactStore;
};

export async function startGatewayServer(
  options: GatewayServerOptions,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok', protocolVersion: 1 });
        return;
      }
      const owner = await options.authenticate(request);
      if (request.method === 'POST' && url.pathname === '/sessions') {
        sendJson(response, 201, await options.gateway.create(owner));
        return;
      }
      const runMatch = url.pathname.match(/^\/sessions\/([^/]+)\/runs$/);
      if (request.method === 'POST' && runMatch?.[1]) {
        const sessionId = runMatch[1];
        const token = bearer(request);
        const body = await readJson(request);
        if (typeof body.prompt !== 'string') throw new Error('prompt is required');
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for await (const event of options.gateway.streamRun(
          sessionId,
          token,
          body.prompt,
          typeof body.runId === 'string' ? body.runId : undefined,
        )) {
          response.write(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        response.end();
        return;
      }
      const replayMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (request.method === 'GET' && replayMatch?.[1]) {
        if (!options.gateway.canView(replayMatch[1], owner)) throw new Error('Session view denied');
        const from = Number(url.searchParams.get('after') ?? 0);
        sendJson(response, 200, options.gateway.replay(replayMatch[1], from));
        return;
      }
      const permissionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/permissions\/([^/]+)$/);
      if (request.method === 'POST' && permissionMatch?.[1] && permissionMatch[2]) {
        const body = await readJson(request);
        if (body.decision !== 'allow' && body.decision !== 'deny') {
          throw new Error('decision must be allow or deny');
        }
        const resolved = options.gateway.respondToPermission(
          permissionMatch[1],
          bearer(request),
          permissionMatch[2],
          body.decision,
        );
        sendJson(response, resolved ? 200 : 404, { resolved });
        return;
      }
      const interruptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && interruptMatch?.[1]) {
        options.gateway.interrupt(interruptMatch[1], bearer(request), 'remote interrupt');
        sendJson(response, 200, { interrupted: true });
        return;
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === 'DELETE' && sessionMatch?.[1]) {
        await options.gateway.close(sessionMatch[1], bearer(request));
        sendJson(response, 200, { closed: true });
        return;
      }
      const uploadMatch = url.pathname.match(/^\/sessions\/([^/]+)\/artifacts$/);
      if (request.method === 'POST' && uploadMatch?.[1] && options.artifactStore) {
        const sessionId = uploadMatch[1];
        if (!options.gateway.canView(sessionId, owner)) throw new Error('Session view denied');
        const body = await readJson(request, 10_000_000);
        if (typeof body.content !== 'string') throw new Error('artifact content is required');
        const artifact = await options.artifactStore.put(
          body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : body.content,
          {
            contentType:
              typeof body.contentType === 'string' ? body.contentType : 'application/octet-stream',
            metadata: { sessionId, owner },
          },
        );
        sendJson(response, 201, artifact);
        return;
      }
      const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)$/);
      if (request.method === 'GET' && artifactMatch?.[1] && options.artifactStore) {
        const artifact = await options.artifactStore.describe(artifactMatch[1]);
        const sessionId = artifact?.metadata.sessionId;
        if (
          !artifact ||
          typeof sessionId !== 'string' ||
          !options.gateway.canView(sessionId, owner)
        ) {
          throw new Error('Artifact view denied');
        }
        const content = await options.artifactStore.get(artifact.id);
        response.writeHead(200, { 'content-type': artifact.contentType });
        response.end(content);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind');
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

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new Error('Bearer control token required');
  return authorization.slice('Bearer '.length);
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
