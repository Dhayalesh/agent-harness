export { createAgentSession, resumeAgentSession } from './core/agent-session.js';
export type { AgentLimits, AgentSession, AgentSessionConfig } from './core/agent-session.js';
export type { AgentEvent, EventPayload } from './core/events.js';
export { isSerializableEvent } from './core/events.js';
export type {
  AgentInput,
  AgentMessage,
  MessageContent,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './core/messages.js';
export { AgentAbortError, AgentHarnessError } from './core/errors.js';
export type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
  StopReason,
} from './models/provider.js';
export {
  createOpenRouterProvider,
  listOpenRouterModels,
  OPENROUTER_BASE_URL,
  OpenRouterModelProvider,
} from './models/openrouter-provider.js';
export type {
  ListOpenRouterModelsOptions,
  OpenRouterModel,
  OpenRouterProviderOptions,
} from './models/openrouter-provider.js';
export { RetryModelProvider } from './models/retry-provider.js';
export type { RetryProviderOptions } from './models/retry-provider.js';
export { ScriptedModelProvider } from './models/scripted-provider.js';
export type { ScriptedStep } from './models/scripted-provider.js';
export { ModelProviderRegistry } from './models/registry.js';
export { OpenAICompatibleModelProvider } from './models/openai-compatible-provider.js';
export type { OpenAICompatibleProviderOptions } from './models/openai-compatible-provider.js';
export {
  AllowAllPermissionHandler,
  DefaultPermissionHandler,
  DenyAllPermissionHandler,
} from './permissions/permission-handler.js';
export { RulePermissionHandler } from './permissions/rule-permission-handler.js';
export type {
  PermissionMode,
  PermissionRule,
  RulePermissionOptions,
} from './permissions/rule-permission-handler.js';
export type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './permissions/permission-handler.js';
export { ToolRegistry } from './tools/registry.js';
export type {
  Tool,
  ToolDescriptor,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolKind,
} from './tools/tool.js';
export { LocalRuntimeHost } from './runtime/local-runtime-host.js';
export type {
  RuntimeDirectoryEntry,
  RuntimeExecOptions,
  RuntimeExecResult,
  RuntimeFileStat,
  RuntimeHost,
} from './runtime/runtime-host.js';
export {
  createBashTool,
  createBuiltinTools,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createWriteFileTool,
  FileSnapshotStore,
} from './tools/builtin/index.js';
export type { BuiltinToolOptions } from './tools/builtin/index.js';
export {
  assertHostAllowed,
  createTavilySearchProvider,
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  decodeHtmlEntities,
  extractHtmlTitle,
  htmlToReadableText,
  isNonPublicHost,
  isSameSiteRedirect,
  MAX_FETCH_URL_LENGTH,
  resolveFetchUrl,
  TAVILY_SEARCH_ENDPOINT,
  tavilyProviderFromEnvironment,
} from './tools/web/index.js';
export type {
  TavilySearchProviderOptions,
  UrlPolicyOptions,
  WebFetchInput,
  WebFetchSummarizer,
  WebFetchToolOptions,
  WebSearchHit,
  WebSearchInput,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchToolOptions,
  WebToolsOptions,
} from './tools/web/index.js';
export {
  CompactingContextManager,
  estimateMessagesTokens,
  PassthroughContextManager,
} from './context/context-manager.js';
export type {
  CompactingContextOptions,
  ContextManager,
  ContextRequest,
  PreparedContext,
} from './context/context-manager.js';
export { composeSystemPrompt } from './context/system-prompt.js';
export type { SystemPromptSection } from './context/system-prompt.js';
export { HookRegistry } from './hooks/hooks.js';
export type { AgentHook, BeforeToolResult, HookContext, StopHookResult } from './hooks/hooks.js';
export { FileSessionStore } from './sessions/file-session-store.js';
export { InMemorySessionStore } from './sessions/session-store.js';
export type { SessionStore, StoredSession } from './sessions/session-store.js';
export { parseCommand, serializeEvent } from './transports/jsonl.js';
export type { JsonlCommand } from './transports/jsonl.js';
export { startAgentSseServer } from './adapters/server/sse-server.js';
export type { AgentServerOptions, RunningAgentServer } from './adapters/server/sse-server.js';
export { harnessConfigSchema, loadJsonConfig, mergeConfigLayers } from './config/config.js';
export type { ConfigLayer, HarnessConfig } from './config/config.js';
export { CommandRegistry } from './commands/commands.js';
export type {
  AgentCommand,
  CommandResolution,
  LocalCommand,
  PromptCommand,
} from './commands/commands.js';
export {
  createSkillTool,
  loadSkillsDirectory,
  parseSkill,
  SkillRegistry,
} from './skills/skills.js';
export type { Skill } from './skills/skills.js';
export { PluginLoader } from './plugins/plugins.js';
export type {
  AgentHarnessPlugin,
  LoadedPlugin,
  PluginCapability,
  PluginContext,
  PluginLoaderContext,
  PluginLoaderOptions,
  PluginManifest,
} from './plugins/plugins.js';
export { McpConnection } from './mcp/client.js';
export type {
  McpConnectionOptions,
  McpElicitationHandler,
  McpPrompt,
  McpPromptResult,
  McpResource,
  McpResourceContent,
} from './mcp/client.js';
export const AGENT_PROTOCOL_VERSION = 1 as const;
export { createHarnessMcpServer, runHarnessMcpStdioServer } from './mcp/server.js';
export type { HarnessMcpServerOptions } from './mcp/server.js';
export { TaskManager } from './tasks/task-manager.js';
export type {
  StartAgentTask,
  StartShellTask,
  TaskKind,
  TaskManagerOptions,
  TaskRecord,
  TaskStatus,
} from './tasks/task-manager.js';
export { createTaskTools } from './tasks/task-tools.js';
export { createInMemoryChannelPair } from './transports/message-channel.js';
export type { MessageChannel } from './transports/message-channel.js';
export { RemoteRuntimeHost, RuntimeRpcServer } from './runtime/remote-runtime.js';
export type { RuntimeRpcMessage } from './runtime/remote-runtime.js';
export { SessionGateway } from './gateway/session-gateway.js';
export type { GatewaySession, SessionGatewayOptions } from './gateway/session-gateway.js';
export { DesktopAgentAdapter } from './adapters/desktop/desktop-adapter.js';
export { buildIdePrompt, IdeAgentAdapter } from './adapters/ide/ide-adapter.js';
export type { IdeContext } from './adapters/ide/ide-adapter.js';
export { CliAgentAdapter } from './adapters/cli/cli-adapter.js';
export type { CliRenderer } from './adapters/cli/cli-adapter.js';
export { startGatewayServer } from './adapters/server/gateway-server.js';
export type { GatewayServerOptions } from './adapters/server/gateway-server.js';
export { FileArtifactStore, InMemoryArtifactStore } from './artifacts/artifact-store.js';
export type { Artifact, ArtifactStore } from './artifacts/artifact-store.js';
export { EnvironmentSecretProvider, InMemorySecretProvider } from './services/secrets.js';
export type { SecretProvider } from './services/secrets.js';
export {
  CompositeEventSink,
  MetricsSink,
  NotificationSink,
  StructuredLogSink,
} from './services/observability.js';
export type { EventSink, HarnessMetrics } from './services/observability.js';
export { BudgetTracker, SessionRateLimiter } from './services/limits.js';
export type { BudgetLimits, RateLimitOptions } from './services/limits.js';
export { runDiagnostics } from './services/diagnostics.js';
export type { DiagnosticCheck, DiagnosticResult } from './services/diagnostics.js';
export { exportTranscriptJson, exportTranscriptMarkdown } from './sessions/transcript.js';
export { formatProjectContext, LocalProjectContextProvider } from './context/project-context.js';
export type { ProjectContext, ProjectContextProvider } from './context/project-context.js';
export { AgentTeamCoordinator, createTeamTool } from './tasks/team-coordinator.js';
export type {
  TeamAgentDefinition,
  TeamAgentResult,
  TeamCoordinatorOptions,
  TeamRunResult,
} from './tasks/team-coordinator.js';
export { createOpenRouterProviderFromSecrets } from './services/provider-auth.js';
export { checkForUpdate, compareVersions } from './services/version-service.js';
export type { VersionInfo, VersionSource } from './services/version-service.js';
export { runParityScenario } from './testing/parity-runner.js';
export type { ParityDifference, ParityResult } from './testing/parity-runner.js';
export { runJsonlAdapter } from './adapters/jsonl/jsonl-adapter.js';
export {
  createAgentCoreDemoProvider,
  startAgentCoreService,
} from './service/agent-core-service.js';
export type {
  AgentCoreServiceOptions,
  RunningAgentCoreService,
} from './service/agent-core-service.js';
export {
  modelProviderAuthSchema,
  modelProviderCapabilitiesSchema,
  modelProviderInputSchema,
  modelProviderRecordSchema,
  modelProviderUpdateSchema,
  modelProviderWireSchema,
  parseModelProviderInput,
  parseModelProviderRecord,
  parseModelProviderUpdate,
} from './platform/model-provider-definitions.js';
export type {
  ModelProviderAuth,
  ModelProviderCapabilities,
  ModelProviderInput,
  ModelProviderRecord,
  ModelProviderUpdate,
  ModelProviderWire,
} from './platform/model-provider-definitions.js';
export {
  MODEL_PROVIDERS_COLLECTION,
  MongoModelProviderStore,
  PLATFORM_MONGO_APP_NAME,
} from './platform/model-provider-store.js';
export type {
  ModelProviderListOptions,
  MongoModelProviderStoreOptions,
  StoredModelProviderRecord,
} from './platform/model-provider-store.js';
export { PlatformModelProviderRegistry } from './platform/model-provider-registry.js';
export type {
  ModelProviderLookup,
  PlatformModelProviderRegistryOptions,
} from './platform/model-provider-registry.js';
export {
  databaseNameFromUri,
  modelProviderConfigFromEnvironment,
  resolveModelProviderFromDatabase,
} from './platform/model-provider-resolution.js';
export type {
  ModelProviderEnvironmentConfig,
  ResolvedModelProvider,
} from './platform/model-provider-resolution.js';
export {
  assertRuntimeSupport,
  RUNTIME_SUPPORT,
  SUPPORTED_HEADER_NAMES,
} from './platform/model-provider-support.js';
export type {
  RuntimeSupportCheckInput,
  SupportedAuthKind,
  SupportedProvider,
  SupportedWireField,
} from './platform/model-provider-support.js';
