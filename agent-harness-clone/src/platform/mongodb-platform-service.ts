import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { FileArtifactStore } from '../artifacts/artifact-store.js';
import { LocalRuntimeHost } from '../runtime/local-runtime-host.js';
import {
  EnvironmentPlatformSecretResolver,
  InlineDataSourceConnector,
  MongoCollectionDataSourceConnector,
  registerBuiltinToolCatalog,
  TrustedDataSourceCatalog,
  TrustedMcpServerCatalog,
  TrustedToolCatalog,
  type PlatformSecretResolver,
} from './catalogs.js';
import { AgentPlatformControlPlane } from './control-plane.js';
import { AgentExecutionPlatform } from './execution.js';
import { DefaultPlatformModelResolver } from './model-resolver.js';
import { MongoPlatformRuntimeStore, MongoTenantSessionStore } from './mongodb-runtime.js';
import { MongoPlatformStore } from './mongodb-store.js';
import { startAgentPlatformServer, type RunningAgentPlatformServer } from './api-server.js';
import { AgentPlatformSessionManager } from './session-manager.js';
import type { PlatformPrincipal } from './definitions.js';
import { mcpServerBindingSchema } from './definitions.js';

export type MongoAgentPlatformOptions = {
  mongoUri: string;
  databaseName: string;
  bootstrapApiKey: string;
  bootstrapTenantId: string;
  workspaceRoot: string;
  artifactRoot: string;
  secrets?: PlatformSecretResolver;
  mcpServers?: TrustedMcpServerCatalog;
  host?: string;
  port?: number;
};

export type RunningMongoAgentPlatform = RunningAgentPlatformServer & {
  controlPlane: AgentPlatformControlPlane;
  sessions: AgentPlatformSessionManager;
};

export async function startMongoAgentPlatform(
  options: MongoAgentPlatformOptions,
): Promise<RunningMongoAgentPlatform> {
  if (!options.bootstrapApiKey) throw new Error('bootstrapApiKey is required');
  const client = new MongoClient(options.mongoUri, { appName: 'trueai-agent-platform' });
  await client.connect();
  const store = new MongoPlatformStore({ client, databaseName: options.databaseName });
  const runtimeStore = new MongoPlatformRuntimeStore({
    client,
    databaseName: options.databaseName,
  });
  const controlPlane = new AgentPlatformControlPlane(store);
  const tools = new TrustedToolCatalog();
  registerBuiltinToolCatalog(tools);
  const dataSources = new TrustedDataSourceCatalog();
  dataSources.register(new InlineDataSourceConnector());
  dataSources.register(new MongoCollectionDataSourceConnector(runtimeStore.database));
  const secrets =
    options.secrets ??
    new EnvironmentPlatformSecretResolver(
      'PLATFORM_SECRET_',
      process.env.PLATFORM_ALLOW_GLOBAL_SECRETS === 'true',
    );
  const execution = new AgentExecutionPlatform({
    controlPlane,
    models: new DefaultPlatformModelResolver(secrets, {
      allowedCustomBaseURLs: new Set(
        (process.env.PLATFORM_ALLOWED_MODEL_BASE_URLS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    }),
    tools,
    dataSources,
    secrets,
    mcpServers:
      options.mcpServers ?? mcpCatalogFromJson(process.env.PLATFORM_MCP_CATALOG_JSON ?? '[]'),
    createRuntime: async (context) => {
      const workspace = path.join(
        path.resolve(options.workspaceRoot),
        safeSegment(context.principal.tenantId),
        safeSegment(context.agentId),
        safeSegment(context.sessionId),
      );
      await mkdir(workspace, { recursive: true });
      return new LocalRuntimeHost(workspace);
    },
    createSessionStore: async (context) => {
      const sessionStore = new MongoTenantSessionStore(
        runtimeStore.database,
        context.principal.tenantId,
      );
      await sessionStore.initialize();
      return sessionStore;
    },
    createArtifactStore: async (context) => {
      const directory = path.join(
        path.resolve(options.artifactRoot),
        safeSegment(context.principal.tenantId),
        safeSegment(context.agentId),
        safeSegment(context.sessionId),
      );
      await mkdir(directory, { recursive: true });
      return new FileArtifactStore(directory);
    },
  });
  const sessions = new AgentPlatformSessionManager(execution, runtimeStore);
  await Promise.all([controlPlane.initialize(), sessions.initialize()]);
  const running = await startAgentPlatformServer({
    controlPlane,
    sessions,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    authenticate: (request) =>
      authenticatePlatformRequest(
        request,
        options.bootstrapApiKey,
        options.bootstrapTenantId,
        controlPlane,
      ),
  });
  return {
    ...running,
    controlPlane,
    sessions,
    close: async () => {
      await sessions.closeAll();
      await running.close();
      await Promise.allSettled([store.close(), runtimeStore.close()]);
      await client.close();
    },
  };
}

async function authenticatePlatformRequest(
  request: IncomingMessage,
  bootstrapApiKey: string,
  bootstrapTenantId: string,
  controlPlane: AgentPlatformControlPlane,
): Promise<PlatformPrincipal> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new Error('Bearer platform API key required');
  const secret = authorization.slice('Bearer '.length);
  if (constantTimeEqual(secret, bootstrapApiKey)) {
    return {
      tenantId: bootstrapTenantId,
      userId: 'bootstrap-admin',
      roles: ['admin'],
    };
  }
  const principal = await controlPlane.authenticateApiKey(secret);
  if (!principal) throw new Error('Invalid platform API key');
  return principal;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

function mcpCatalogFromJson(value: string): TrustedMcpServerCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('PLATFORM_MCP_CATALOG_JSON must contain valid JSON');
  }
  const bindings = mcpServerBindingSchema.array().parse(parsed);
  const catalog = new TrustedMcpServerCatalog();
  for (const binding of bindings) catalog.register(binding);
  return catalog;
}
