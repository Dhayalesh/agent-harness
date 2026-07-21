import type { ArtifactStore } from '../artifacts/artifact-store.js';
import { InMemoryArtifactStore } from '../artifacts/artifact-store.js';
import {
  createAgentSession,
  resumeAgentSession,
  type AgentSession,
  type AgentSessionConfig,
} from '../core/agent-session.js';
import type { AgentEvent } from '../core/events.js';
import type { AgentInput, AgentMessage } from '../core/messages.js';
import { McpConnection } from '../mcp/client.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import type { RuntimeHost } from '../runtime/runtime-host.js';
import type { EventSink } from '../services/observability.js';
import { InMemorySessionStore, type SessionStore } from '../sessions/session-store.js';
import type { AgentPlatformControlPlane } from './control-plane.js';
import type { McpServerBinding, PlatformPrincipal } from './definitions.js';
import { newId } from './definitions.js';
import { TrustedMcpServerCatalog } from './catalogs.js';
import type {
  PlatformSecretResolver,
  TrustedDataSourceCatalog,
  TrustedToolCatalog,
} from './catalogs.js';
import type { PlatformModelResolver } from './model-resolver.js';

export type AgentExecutionContext = {
  principal: PlatformPrincipal;
  agentId: string;
  versionId: string;
  environment: string;
  sessionId: string;
};

export type AgentExecutionPlatformOptions = {
  controlPlane: AgentPlatformControlPlane;
  models: PlatformModelResolver;
  tools: TrustedToolCatalog;
  dataSources: TrustedDataSourceCatalog;
  secrets: PlatformSecretResolver;
  createRuntime(context: AgentExecutionContext): RuntimeHost | Promise<RuntimeHost>;
  createSessionStore?: (context: AgentExecutionContext) => SessionStore | Promise<SessionStore>;
  createArtifactStore?: (context: AgentExecutionContext) => ArtifactStore | Promise<ArtifactStore>;
  eventSink?: EventSink;
  mcpServers?: TrustedMcpServerCatalog;
};

export class AgentExecutionPlatform {
  constructor(private readonly options: AgentExecutionPlatformOptions) {}

  async createSession(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment = 'production',
  ): Promise<AgentSession> {
    return this.openSession(principal, agentIdOrSlug, environment, newId(), false);
  }

  async resumeSession(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment: string,
    sessionId: string,
  ): Promise<AgentSession> {
    return this.openSession(principal, agentIdOrSlug, environment, sessionId, true);
  }

  private async openSession(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment: string,
    sessionId: string,
    resume: boolean,
  ): Promise<AgentSession> {
    const resolved = await this.options.controlPlane.resolveDeployment(
      principal,
      agentIdOrSlug,
      environment,
    );
    const context: AgentExecutionContext = {
      principal,
      agentId: resolved.agent.id,
      versionId: resolved.version.id,
      environment,
      sessionId,
    };
    const runtime = await this.options.createRuntime(context);
    const provider = await this.options.models.resolve(
      principal.tenantId,
      resolved.version.definition.model,
    );
    const tools = this.options.tools.resolve(resolved.version.definition.tools, runtime);
    const connections = await connectMcpServers(
      resolved.version.definition.mcpServers,
      principal.tenantId,
      this.options.secrets,
      this.options.mcpServers ?? new TrustedMcpServerCatalog(),
    );
    try {
      for (const connection of connections) tools.push(...(await connection.tools()));
      const sessionStore =
        (await this.options.createSessionStore?.(context)) ?? new InMemorySessionStore();
      const artifactStore =
        (await this.options.createArtifactStore?.(context)) ?? new InMemoryArtifactStore();
      const definition = resolved.version.definition;
      const sessionConfig: AgentSessionConfig = {
        sessionId: context.sessionId,
        provider,
        model: definition.model.model,
        workingDirectory: runtime.rootDirectory,
        tools,
        permissionHandler: new RulePermissionHandler({
          mode: definition.permissions.mode,
          fallback: definition.permissions.fallback,
          rules: definition.permissions.rules.map((rule) => ({
            tool: rule.tool,
            decision: rule.decision,
            ...(rule.inputPattern === undefined ? {} : { inputPattern: rule.inputPattern }),
            ...(rule.source === undefined ? {} : { source: rule.source }),
          })),
        }),
        sessionStore,
        artifactStore,
        ...(this.options.eventSink === undefined ? {} : { eventSink: this.options.eventSink }),
        limits: {
          maxTurns: definition.limits.maxTurns,
          ...(definition.limits.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: definition.limits.maxInputTokens }),
          ...(definition.limits.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: definition.limits.maxOutputTokens }),
        },
        budget: {
          ...(definition.limits.maxTotalTokens === undefined
            ? {}
            : { maxTotalTokens: definition.limits.maxTotalTokens }),
          ...(definition.limits.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: definition.limits.maxCostUsd }),
        },
        systemPrompt: composeAgentInstructions(
          definition.systemPrompt,
          definition.skills,
          resolved.version.checksum,
        ),
        metadata: {
          tenantId: principal.tenantId,
          agentId: resolved.agent.id,
          agentVersionId: resolved.version.id,
          agentVersion: resolved.version.version,
          deploymentEnvironment: environment,
          deploymentRevision: resolved.deployment.revision,
        },
      };
      const session = resume
        ? await resumeAgentSession({ ...sessionConfig, sessionStore }, context.sessionId)
        : createAgentSession(sessionConfig);
      return new DataAwareAgentSession(
        session,
        connections,
        this.options.dataSources,
        definition.dataSources,
        this.options.secrets,
        context,
      );
    } catch (error) {
      await Promise.allSettled(connections.map((connection) => connection.close()));
      throw error;
    }
  }
}

class DataAwareAgentSession implements AgentSession {
  private activeRetrieval: AbortController | undefined;

  constructor(
    private readonly session: AgentSession,
    private readonly connections: McpConnection[],
    private readonly dataSources: TrustedDataSourceCatalog,
    private readonly bindings: Parameters<TrustedDataSourceCatalog['retrieve']>[0],
    private readonly secrets: PlatformSecretResolver,
    private readonly context: AgentExecutionContext,
  ) {}

  get id(): string {
    return this.session.id;
  }

  get messages(): readonly AgentMessage[] {
    return this.session.messages;
  }

  async *run(input: AgentInput): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    this.activeRetrieval = controller;
    try {
      const sources = await this.dataSources.retrieve(this.bindings, {
        principal: this.context.principal,
        agentId: this.context.agentId,
        prompt: input.prompt,
        signal: controller.signal,
        secrets: this.secrets,
      });
      const data = sources
        .filter((source) => source.documents.length)
        .map(
          (source) =>
            `<data-source name="${source.source}">\n${source.documents
              .map((document) => `<document id="${document.id}">\n${document.text}\n</document>`)
              .join('\n')}\n</data-source>`,
        )
        .join('\n');
      const prompt = data
        ? `${input.prompt}\n\n<retrieved-data>\n${data}\n</retrieved-data>`
        : input.prompt;
      yield* this.session.run({ prompt });
    } finally {
      this.activeRetrieval = undefined;
    }
  }

  interrupt(reason?: string): void {
    this.activeRetrieval?.abort(reason);
    this.session.interrupt(reason);
  }

  respondToPermission(requestId: string, decision: 'allow' | 'deny'): boolean {
    return this.session.respondToPermission(requestId, decision);
  }

  async close(): Promise<void> {
    await this.session.close();
    await Promise.allSettled(this.connections.map((connection) => connection.close()));
  }
}

function composeAgentInstructions(
  systemPrompt: string,
  skills: readonly {
    name: string;
    version: string;
    description: string;
    instructions: string;
    allowedTools?: string[] | undefined;
  }[],
  checksum: string,
): string {
  const skillText = skills
    .map(
      (skill) =>
        `<skill name="${skill.name}" version="${skill.version}">\n${skill.description}\n${skill.instructions}${
          skill.allowedTools?.length ? `\nAllowed tools: ${skill.allowedTools.join(', ')}` : ''
        }\n</skill>`,
    )
    .join('\n\n');
  return [
    systemPrompt,
    `<agent-definition checksum="${checksum}" />`,
    skillText ? `<configured-skills>\n${skillText}\n</configured-skills>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function connectMcpServers(
  bindings: readonly McpServerBinding[],
  tenantId: string,
  secrets: PlatformSecretResolver,
  catalog: TrustedMcpServerCatalog,
): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  try {
    for (const binding of bindings) {
      catalog.assertTrusted(binding);
      if (binding.transport === 'stdio') {
        connections.push(
          await McpConnection.connectStdio(binding.name, {
            command: binding.command as string,
            ...(binding.args === undefined ? {} : { args: binding.args }),
          }),
        );
      } else {
        const headers = await resolveSecretHeaders(
          binding.headers,
          binding.secretRefs,
          tenantId,
          secrets,
        );
        connections.push(
          await McpConnection.connectHttp(binding.name, new URL(binding.url as string), {
            requestInit: { headers },
          }),
        );
      }
    }
    return connections;
  } catch (error) {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    throw error;
  }
}

async function resolveSecretHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  secretRefs: readonly string[] | undefined,
  tenantId: string,
  secrets: PlatformSecretResolver,
): Promise<Record<string, string>> {
  const allowed = new Set(secretRefs ?? []);
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!value.startsWith('$secret:')) {
      resolved[name] = value;
      continue;
    }
    const reference = value.slice('$secret:'.length);
    if (!allowed.has(reference)) throw new Error(`MCP header uses undeclared secret: ${reference}`);
    const secret = await secrets.get(tenantId, reference);
    if (!secret) throw new Error(`Missing MCP secret: ${reference}`);
    resolved[name] = secret;
  }
  return resolved;
}
