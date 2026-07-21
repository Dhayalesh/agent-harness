import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentPlatformControlPlane } from './control-plane.js';
import type { PlatformPrincipal, PlatformRole } from './definitions.js';
import type { AgentPlatformSessionManager } from './session-manager.js';

export type AgentPlatformServerOptions = {
  controlPlane: AgentPlatformControlPlane;
  sessions: AgentPlatformSessionManager;
  authenticate(request: IncomingMessage): PlatformPrincipal | Promise<PlatformPrincipal>;
  host?: string;
  port?: number;
};

export type RunningAgentPlatformServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function startAgentPlatformServer(
  options: AgentPlatformServerOptions,
): Promise<RunningAgentPlatformServer> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok', service: 'agent-platform', protocolVersion: 1 });
        return;
      }
      const principal = await options.authenticate(request);

      if (request.method === 'GET' && url.pathname === '/v1/agents') {
        sendJson(response, 200, await options.controlPlane.listAgents(principal));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        sendJson(
          response,
          200,
          await options.sessions.list(principal, numberQuery(url, 'limit') ?? 100),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/agents') {
        const body = await readJson(request);
        sendJson(
          response,
          201,
          await options.controlPlane.createAgent(principal, {
            slug: stringField(body, 'slug'),
            name: stringField(body, 'name'),
            ...(typeof body.description === 'string' ? { description: body.description } : {}),
          }),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/audit') {
        const resourceId = url.searchParams.get('resourceId') ?? undefined;
        const limit = numberQuery(url, 'limit');
        sendJson(response, 200, await options.controlPlane.listAudit(principal, resourceId, limit));
        return;
      }
      if (url.pathname === '/v1/api-keys') {
        if (request.method === 'GET') {
          sendJson(response, 200, await options.controlPlane.listApiKeys(principal));
          return;
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          sendJson(
            response,
            201,
            await options.controlPlane.createApiKey(
              principal,
              stringField(body, 'name'),
              rolesField(body.roles),
            ),
          );
          return;
        }
      }
      const apiKeyMatch = url.pathname.match(/^\/v1\/api-keys\/([^/]+)$/);
      if (request.method === 'DELETE' && apiKeyMatch?.[1]) {
        await options.controlPlane.revokeApiKey(principal, decodeURIComponent(apiKeyMatch[1]));
        sendJson(response, 200, { revoked: true });
        return;
      }

      const versionsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/versions$/);
      if (versionsMatch?.[1]) {
        const agent = decodeURIComponent(versionsMatch[1]);
        if (request.method === 'GET') {
          sendJson(response, 200, await options.controlPlane.listVersions(principal, agent));
          return;
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          sendJson(
            response,
            201,
            await options.controlPlane.createVersion(principal, agent, body.definition),
          );
          return;
        }
      }
      const deploymentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/deployments$/);
      if (deploymentMatch?.[1]) {
        const agent = decodeURIComponent(deploymentMatch[1]);
        if (request.method === 'GET') {
          sendJson(response, 200, await options.controlPlane.listDeployments(principal, agent));
          return;
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          sendJson(
            response,
            200,
            await options.controlPlane.publish(
              principal,
              agent,
              versionIdentity(body.version),
              typeof body.environment === 'string' ? body.environment : 'production',
            ),
          );
          return;
        }
      }
      const rollbackMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/rollback$/);
      if (request.method === 'POST' && rollbackMatch?.[1]) {
        const body = await readJson(request);
        sendJson(
          response,
          200,
          await options.controlPlane.rollback(
            principal,
            decodeURIComponent(rollbackMatch[1]),
            versionIdentity(body.version),
            typeof body.environment === 'string' ? body.environment : 'production',
          ),
        );
        return;
      }
      const createSessionMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/sessions$/);
      if (request.method === 'POST' && createSessionMatch?.[1]) {
        const body = await readJson(request);
        sendJson(
          response,
          201,
          await options.sessions.create(
            principal,
            decodeURIComponent(createSessionMatch[1]),
            typeof body.environment === 'string' ? body.environment : 'production',
          ),
        );
        return;
      }
      const runMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/runs$/);
      if (request.method === 'POST' && runMatch?.[1]) {
        const body = await readJson(request);
        const sessionId = decodeURIComponent(runMatch[1]);
        const controlToken = sessionControlToken(request);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let completed = false;
        response.once('close', () => {
          if (!completed) {
            void options.sessions.interrupt(
              principal,
              sessionId,
              controlToken,
              'API client disconnected',
            );
          }
        });
        for await (const event of options.sessions.streamRun(
          principal,
          sessionId,
          controlToken,
          stringField(body, 'prompt'),
          typeof body.runId === 'string' ? body.runId : undefined,
        )) {
          response.write(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        completed = true;
        response.end();
        return;
      }
      const runStatusMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runStatusMatch?.[1] && runStatusMatch[2]) {
        sendJson(
          response,
          200,
          await options.sessions.getRun(
            principal,
            decodeURIComponent(runStatusMatch[1]),
            decodeURIComponent(runStatusMatch[2]),
          ),
        );
        return;
      }
      const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsMatch?.[1]) {
        sendJson(
          response,
          200,
          await options.sessions.replay(
            principal,
            decodeURIComponent(eventsMatch[1]),
            numberQuery(url, 'after') ?? 0,
          ),
        );
        return;
      }
      const permissionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/permissions\/([^/]+)$/);
      if (request.method === 'POST' && permissionMatch?.[1] && permissionMatch[2]) {
        const body = await readJson(request);
        if (body.decision !== 'allow' && body.decision !== 'deny') {
          throw new Error('decision must be allow or deny');
        }
        const resolved = await options.sessions.respondToPermission(
          principal,
          decodeURIComponent(permissionMatch[1]),
          sessionControlToken(request),
          decodeURIComponent(permissionMatch[2]),
          body.decision,
        );
        sendJson(response, resolved ? 200 : 404, { resolved });
        return;
      }
      const interruptMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && interruptMatch?.[1]) {
        await options.sessions.interrupt(
          principal,
          decodeURIComponent(interruptMatch[1]),
          sessionControlToken(request),
        );
        sendJson(response, 200, { interrupted: true });
        return;
      }
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === 'DELETE' && sessionMatch?.[1]) {
        await options.sessions.close(
          principal,
          decodeURIComponent(sessionMatch[1]),
          sessionControlToken(request),
        );
        sendJson(response, 200, { closed: true });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (agentMatch?.[1]) {
        const agent = decodeURIComponent(agentMatch[1]);
        if (request.method === 'GET') {
          sendJson(response, 200, await options.controlPlane.getAgent(principal, agent));
          return;
        }
        if (request.method === 'DELETE') {
          await options.controlPlane.archiveAgent(principal, agent);
          sendJson(response, 200, { archived: true });
          return;
        }
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, errorStatus(error), {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Agent platform server did not bind');
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

function sessionControlToken(request: IncomingMessage): string {
  const value = request.headers['x-agent-control-token'];
  if (typeof value !== 'string' || !value) throw new Error('x-agent-control-token is required');
  return value;
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = 2_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body must be an object');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || !result.trim()) throw new Error(`${field} is required`);
  return result;
}

function versionIdentity(value: unknown): string | number {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new Error('version must be a version ID or positive version number');
}

function rolesField(value: unknown): PlatformRole[] {
  const allowed = new Set<PlatformRole>(['admin', 'editor', 'executor', 'viewer']);
  if (!Array.isArray(value) || !value.length || !value.every((role) => allowed.has(role))) {
    throw new Error('roles must contain valid platform roles');
  }
  return [...new Set(value as PlatformRole[])];
}

function numberQuery(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Bearer platform API key required|Invalid platform API key|x-agent-control-token is required/i.test(
      message,
    )
  )
    return 401;
  if (/Role required|role is required|control denied|view denied/i.test(message)) return 403;
  if (/^Unknown |not deployed|No deployment exists/i.test(message)) return 404;
  return 400;
}
