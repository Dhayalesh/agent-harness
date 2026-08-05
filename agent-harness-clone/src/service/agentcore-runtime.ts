import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { startAgentCoreRuntimeServer } from '../adapters/server/agentcore-server.js';
import { FileArtifactStore } from '../artifacts/artifact-store.js';
import { LocalProjectContextProvider } from '../context/project-context.js';
import { createAgentSession } from '../core/agent-session.js';
import { SessionGateway } from '../gateway/session-gateway.js';
import type { PermissionHandler } from '../permissions/permission-handler.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import type { AgentCacheOptions } from '../platform/agent-cache.js';
import { AgentCache, rebindLocalTools } from '../platform/agent-cache.js';
import type { AgentEnvironmentConfig } from '../platform/agent-resolution.js';
import { agentConfigFromEnvironment } from '../platform/agent-resolution.js';
import { LocalRuntimeHost, scrubbedEnvironment } from '../runtime/local-runtime-host.js';
import { MetricsSink } from '../services/observability.js';
import { FileSessionStore } from '../sessions/file-session-store.js';
import type { BuiltinToolOptions } from '../tools/builtin/index.js';
import { createBuiltinTools } from '../tools/builtin/index.js';
import type { Tool } from '../tools/tool.js';

export type AgentCoreRuntimeOptions = {
  /**
   * The parent of every session's workspace, not a workspace itself. Each session
   * is rooted in its own directory beneath this one.
   */
  workspace: string;
  dataDirectory: string;
  /** Defaults to `PLATFORM_MONGODB_URI`. */
  agentConfig?: AgentEnvironmentConfig;
  /**
   * Passed to the cache. `localTools` is not accepted: the catalogue has to be the
   * one these sessions are actually built from, so it is derived here.
   */
  agentCacheOptions?: Omit<AgentCacheOptions, 'localTools'>;
  builtinToolOptions?: BuiltinToolOptions;
  /**
   * Defaults to rules with no interactive fallback. See the note on
   * `createPermissionHandler` below for why the default is not `ask`.
   */
  createPermissionHandler?: () => PermissionHandler;
  /**
   * The environment spawned commands receive. Defaults to `scrubbedEnvironment()`,
   * which drops everything outside the allowlist. Pass a wider one only if the
   * deployment's tools need a specific variable.
   */
  shellEnvironment?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
};

export type RunningAgentCoreRuntime = {
  server: Server;
  url: string;
  gateway: SessionGateway;
  metrics: MetricsSink;
  agents: AgentCache;
  close(): Promise<void>;
};

/**
 * Assembles the harness behind the AgentCore Runtime HTTP contract.
 *
 * Three things differ from `startAgentCoreService`, and each of them is what
 * makes a shared deployment rather than a single-tenant one:
 *
 * 1. The agent comes from the `agents` collection per session, named by the
 *    caller, instead of one provider and one hardcoded prompt fixed at startup.
 * 2. Every session gets its own workspace directory, so one caller's files are
 *    not another's. A single shared root is safe for one operator on one machine
 *    and is not safe for several applications on one deployment.
 * 3. Spawned commands get a narrowed environment, because the process
 *    environment here holds the platform's database URI and bucket credentials
 *    while a shell tool is reachable by any agent record that names it.
 */
export async function startAgentCoreRuntime(
  options: AgentCoreRuntimeOptions,
): Promise<RunningAgentCoreRuntime> {
  const workspaceRoot = path.resolve(options.workspace);
  const dataDirectory = path.resolve(options.dataDirectory);
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(path.join(dataDirectory, 'sessions'), { recursive: true }),
    mkdir(path.join(dataDirectory, 'artifacts'), { recursive: true }),
  ]);

  const toolOptions = options.builtinToolOptions ?? {};
  const shellEnvironment = options.shellEnvironment ?? scrubbedEnvironment();
  const sessionStore = new FileSessionStore(path.join(dataDirectory, 'sessions'));
  const artifactStore = new FileArtifactStore(path.join(dataDirectory, 'artifacts'));
  const metrics = new MetricsSink();

  // Built after the mkdir above so the host's eager realpath resolves. Only the
  // names are used, to check `agents.tools` against what this host offers; the
  // instances a session runs are rebuilt against that session's own workspace.
  const catalogue = referenceToolCatalogue(workspaceRoot, shellEnvironment, toolOptions);
  const agents = new AgentCache(options.agentConfig ?? agentConfigFromEnvironment(), {
    ...(options.agentCacheOptions ?? {}),
    localTools: catalogue,
  });
  await agents.connect();

  const gateway = new SessionGateway({
    createSession: async (request) => {
      const agent = await agents.get(request.agentName);
      // The id is generated here rather than left to the session, because it names
      // the directory the session's tools are rooted in and so has to exist first.
      const sessionId = randomUUID();
      const sessionWorkspace = path.join(workspaceRoot, sessionId);
      await mkdir(sessionWorkspace, { recursive: true });
      const runtime = new LocalRuntimeHost(sessionWorkspace, { env: shellEnvironment });
      const tools = rebindLocalTools(agent.tools, createBuiltinTools(runtime, toolOptions));

      return createAgentSession({
        sessionId,
        provider: agent.provider,
        ...(agent.model === undefined ? {} : { model: agent.model }),
        systemPrompt: agent.systemPrompt,
        workingDirectory: sessionWorkspace,
        tools,
        limits: agent.limits,
        permissionHandler:
          options.createPermissionHandler?.() ?? new RulePermissionHandler({ fallback: 'deny' }),
        sessionStore,
        artifactStore,
        eventSink: metrics,
        projectContextProvider: new LocalProjectContextProvider(runtime),
        metadata: { agentName: agent.record.name, ownerId: request.ownerId },
      });
    },
  });

  const running = await startAgentCoreRuntimeServer({
    gateway,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  return {
    ...running,
    gateway,
    metrics,
    agents,
    close: async () => {
      await running.close();
      await agents.close();
    },
  };
}

/**
 * The local tools this host offers, by name.
 *
 * Rooted at the shared workspace parent and never executed: `PlatformAgentRegistry`
 * needs a catalogue to check each `agents.tools` entry against, and a name is all
 * that check reads. Built with the same options as the per-session catalogues so
 * the two sets cannot disagree about which tools exist.
 */
export function referenceToolCatalogue(
  workspaceRoot: string,
  shellEnvironment: NodeJS.ProcessEnv,
  toolOptions: BuiltinToolOptions,
): readonly Tool[] {
  return createBuiltinTools(
    new LocalRuntimeHost(workspaceRoot, { env: shellEnvironment }),
    toolOptions,
  );
}
