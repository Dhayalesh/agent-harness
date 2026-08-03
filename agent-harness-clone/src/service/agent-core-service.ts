import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { startGatewayServer } from '../adapters/server/gateway-server.js';
import { FileArtifactStore } from '../artifacts/artifact-store.js';
import { LocalProjectContextProvider } from '../context/project-context.js';
import { createAgentSession } from '../core/agent-session.js';
import { SessionGateway } from '../gateway/session-gateway.js';
import type { ModelProvider, ModelRequest } from '../models/provider.js';
import { ScriptedModelProvider } from '../models/scripted-provider.js';
import type { PermissionHandler } from '../permissions/permission-handler.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import { LocalRuntimeHost } from '../runtime/local-runtime-host.js';
import { MetricsSink } from '../services/observability.js';
import { FileSessionStore } from '../sessions/file-session-store.js';
import { createBuiltinTools } from '../tools/builtin/index.js';
import type { Tool } from '../tools/tool.js';

export type AgentCoreServiceOptions = {
  workspace: string;
  dataDirectory: string;
  createProvider(): ModelProvider | Promise<ModelProvider>;
  createPermissionHandler?: () => PermissionHandler;
  host?: string;
  port?: number;
  serviceKey?: string;
  systemPrompt?: string;
  /**
   * Tools added to every session on top of the builtins. The entrypoint resolves
   * them once, so the service does not reconnect an MCP server per session.
   */
  additionalTools?: readonly Tool[];
};

export type RunningAgentCoreService = {
  server: Server;
  url: string;
  gateway: SessionGateway;
  metrics: MetricsSink;
  close(): Promise<void>;
};

export async function startAgentCoreService(
  options: AgentCoreServiceOptions,
): Promise<RunningAgentCoreService> {
  const workspace = path.resolve(options.workspace);
  const dataDirectory = path.resolve(options.dataDirectory);
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(path.join(dataDirectory, 'sessions'), { recursive: true }),
    mkdir(path.join(dataDirectory, 'artifacts'), { recursive: true }),
  ]);

  const runtime = new LocalRuntimeHost(workspace);
  const sessionStore = new FileSessionStore(path.join(dataDirectory, 'sessions'));
  const artifactStore = new FileArtifactStore(path.join(dataDirectory, 'artifacts'));
  const metrics = new MetricsSink();
  const gateway = new SessionGateway({
    createSession: async () =>
      createAgentSession({
        provider: await options.createProvider(),
        workingDirectory: workspace,
        // Additional tools last, so a supplied tool cannot shadow a builtin.
        tools: [...createBuiltinTools(runtime), ...(options.additionalTools ?? [])],
        permissionHandler:
          options.createPermissionHandler?.() ?? new RulePermissionHandler({ fallback: 'ask' }),
        sessionStore,
        artifactStore,
        eventSink: metrics,
        projectContextProvider: new LocalProjectContextProvider(runtime),
        systemPrompt:
          options.systemPrompt ??
          'You are an agent running behind an API. Use only the provided tools and report results clearly.',
      }),
  });
  const running = await startGatewayServer({
    gateway,
    artifactStore,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    authenticate(request) {
      if (
        options.serviceKey !== undefined &&
        request.headers['x-agent-service-key'] !== options.serviceKey
      ) {
        throw new Error('Invalid agent service key');
      }
      const owner = request.headers['x-agent-owner'];
      return typeof owner === 'string' && owner.trim() ? owner : 'local-demo';
    },
  });
  return { ...running, gateway, metrics };
}

export function createAgentCoreDemoProvider(): ModelProvider {
  return new ScriptedModelProvider([
    (request) => {
      const prompt = latestUserText(request);
      return [
        {
          type: 'tool_call',
          id: 'demo-write',
          name: 'write_file',
          input: {
            path: '.agent-core-demo.txt',
            content: `Agent-core API received: ${prompt}\n`,
          },
        },
        { type: 'completed', stopReason: 'tool_use' },
      ];
    },
    (request) => {
      const result = request.messages
        .flatMap((message) => message.content)
        .findLast((block) => block.type === 'tool_result');
      const outcome = result?.isError
        ? `Tool was not executed: ${result.content}`
        : result?.content;
      return [
        {
          type: 'text_delta',
          delta: `Agent-core API demo completed. ${outcome ?? 'No tool result was returned.'}`,
        },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
}

function latestUserText(request: ModelRequest): string {
  const message = request.messages.findLast((candidate) => candidate.role === 'user');
  const text = message?.content.find((block) => block.type === 'text');
  return text?.text.trim() || 'empty prompt';
}
