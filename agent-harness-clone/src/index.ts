/**
 * The library surface of a headless agent runtime.
 *
 * One mode, one contract: a payload describes the agent, the model, the MCP servers,
 * and the skills, and `invokeHeadless` runs it. There is no CLI, no session gateway,
 * no database, and no stored configuration — see `src/headless/payload.ts` for the
 * whole of what a run is told.
 *
 * Everything below `headless/` is exported because it is the entry point. Everything
 * else is exported because a payload can reach it: the record schemas a payload is
 * validated against, the registries that assemble it, the tools it may name, and the
 * pieces a session is built from.
 */
export { createAgentSession, resumeAgentSession } from './core/agent-session.js';
export type { AgentLimits, AgentSession, AgentSessionConfig } from './core/agent-session.js';
export type {
  AgentEvent,
  EventPayload,
  RunPreparationStage,
  RunProgressReporter,
} from './core/events.js';
export { isSerializableEvent } from './core/events.js';
export type {
  AgentInput,
  AgentMessage,
  ImageBlock,
  MessageContent,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './core/messages.js';
export { textMessage, userMessage } from './core/messages.js';
export { prepareAttachments } from './files/attachments.js';
export type { PreparedAttachments } from './files/attachments.js';
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
  ToolPermissionCheck,
  ToolPermissionCheckContext,
  ToolPermissionDecision,
} from './tools/tool.js';
export {
  LocalRuntimeHost,
  RUNTIME_ENVIRONMENT_ALLOWLIST,
  scrubbedEnvironment,
} from './runtime/local-runtime-host.js';
export type { LocalRuntimeHostOptions } from './runtime/local-runtime-host.js';
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
  createCodeArtifactTool,
  createCsvArtifactTool,
  createDocumentArtifactTool,
  createHtmlArtifactTool,
  createJsonArtifactTool,
  createMarkdownArtifactTool,
  createSpreadsheetArtifactTool,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createPowerShellTool,
  createReadFileTool,
  createTodoWriteTool,
  createWriteFileTool,
  FileSnapshotStore,
  formatTodos,
  isPowerShellAvailable,
  TodoStore,
} from './tools/builtin/index.js';
export type {
  BashToolOptions,
  BuiltinToolOptions,
  PowerShellToolOptions,
  TodoItem,
  TodoStatus,
} from './tools/builtin/index.js';
export {
  assessPowerShellReadOnly,
  assessReadOnly,
  containsDirectoryChange,
  evaluateShellCommand,
  expandTilde,
  extractOutputRedirections,
  findingsOfSeverity,
  formatFindings,
  getDestructiveCommandWarning,
  hasUnescapedChar,
  inspectBashCommand,
  inspectCommandPaths,
  inspectPowerShellCommand,
  isDangerousRemovalPath,
  parseCommand as parseShellCommand,
  splitCommandSegments,
  splitPipeline,
  stripQuotedContent,
  stripSafeWrappers,
  tokenize,
  worstSeverity,
} from './tools/shell/index.js';
export type {
  CommandSegment,
  FileOperationType,
  FindingSeverity,
  ParsedCommand,
  PathSafetyOptions,
  PowerShellInspection,
  PowerShellReadOnlyAssessment,
  ReadOnlyAssessment,
  Redirection,
  ShellFinding,
  ShellFlavor,
  ShellPermissionOptions,
} from './tools/shell/index.js';
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
  DefaultTokenEstimator,
  DynamicCompactingContextManager,
  estimateMessagesTokens,
  PassthroughContextManager,
  classifyPressure,
  contextPolicyFromPercent,
  DEFAULT_COMPACTION_PERCENT,
  DEFAULT_CONTEXT_POLICY,
} from './context/context-manager.js';
export type {
  CompactingContextOptions,
  CompactionSummaryInput,
  CompactionSkipReason,
  CompactionSummaryResult,
  CompactionSummarizer,
  ContextManager,
  ContextPolicy,
  ContextPressure,
  ContextRequest,
  DynamicCompactingContextOptions,
  ModelContextCapabilities,
  PreparedContext,
  TokenEstimator,
} from './context/context-manager.js';
export { BedrockCompactionSummarizer } from './context/bedrock-compaction-summarizer.js';
export type { BedrockCompactionSummarizerOptions } from './context/bedrock-compaction-summarizer.js';
export { composeSystemPrompt } from './context/system-prompt.js';
export type { SystemPromptSection } from './context/system-prompt.js';
export { HookRegistry } from './hooks/hooks.js';
export type { AgentHook, BeforeToolResult, HookContext, StopHookResult } from './hooks/hooks.js';
export { FileSessionStore } from './sessions/file-session-store.js';
export { S3SessionStore } from './sessions/s3-session-store.js';
export type { S3SessionStoreOptions } from './sessions/s3-session-store.js';
export { TieredSessionStore } from './sessions/tiered-session-store.js';
export { InMemorySessionStore } from './sessions/session-store.js';
export type { SessionStore, SessionStoreOptions, StoredSession } from './sessions/session-store.js';
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
export { FileArtifactStore, InMemoryArtifactStore } from './artifacts/artifact-store.js';
export type { Artifact, ArtifactStore } from './artifacts/artifact-store.js';
export {
  ARTIFACT_FORMATS,
  artifactExtension,
  artifactFilename,
  artifactKindFromContentType,
  CODE_LANGUAGE_NAMES,
  CODE_LANGUAGES,
  codeLanguageFromFilename,
} from './artifacts/artifact-formats.js';
export type {
  ArtifactFormatOptions,
  ArtifactKind,
  CodeLanguage,
} from './artifacts/artifact-formats.js';
export { S3ArtifactStore } from './artifacts/s3-artifact-store.js';
export type { S3ArtifactStoreOptions } from './artifacts/s3-artifact-store.js';
export {
  CompositeEventSink,
  DEFAULT_MAX_LOG_LINE_BYTES,
  emitLog,
  MetricsSink,
  NotificationSink,
  parseLogLevel,
  redactCredentials,
  safeSerialize,
  StructuredLogSink,
} from './services/observability.js';
export type {
  EventSink,
  HarnessLogEntry,
  HarnessLogLevel,
  HarnessMetrics,
  LogContext,
  LogSink,
  StructuredLogSinkOptions,
} from './services/observability.js';
export { CloudWatchLogWriter } from './services/cloudwatch-log-writer.js';
export type { CloudWatchLogWriterOptions } from './services/cloudwatch-log-writer.js';
export { BudgetTracker, SessionRateLimiter } from './services/limits.js';
export type { BudgetLimits, RateLimitOptions } from './services/limits.js';
export { formatProjectContext, LocalProjectContextProvider } from './context/project-context.js';
export type { ProjectContext, ProjectContextProvider } from './context/project-context.js';
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
export { PlatformModelProviderRegistry } from './platform/model-provider-registry.js';
export type {
  ModelProviderLookup,
  PlatformModelProviderRegistryOptions,
} from './platform/model-provider-registry.js';
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
export {
  mcpServerAuthSchema,
  mcpServerCapabilitiesSchema,
  mcpServerInputSchema,
  mcpServerRecordSchema,
  mcpServerUpdateSchema,
  mcpServerWireSchema,
  parseMcpServerInput,
  parseMcpServerRecord,
  parseMcpServerUpdate,
} from './platform/mcp-server-definitions.js';
export type {
  McpServerAuth,
  McpServerCapabilities,
  McpServerInput,
  McpServerRecord,
  McpServerTransport,
  McpServerUpdate,
  McpServerWire,
} from './platform/mcp-server-definitions.js';
export { PlatformMcpServerRegistry } from './platform/mcp-server-registry.js';
export type {
  McpServerLookup,
  PlatformMcpServerRegistryOptions,
} from './platform/mcp-server-registry.js';
export {
  assertMcpRuntimeSupport,
  MCP_RUNTIME_SUPPORT,
  RESERVED_HEADER_NAMES,
} from './platform/mcp-server-support.js';
export type {
  McpRuntimeSupportCheckInput,
  SupportedMcpAuthKind,
  SupportedMcpTransport,
  SupportedMcpWireField,
} from './platform/mcp-server-support.js';
export {
  agentInputSchema,
  agentLimitsSchema,
  agentRecordSchema,
  agentSkillSchema,
  agentUpdateSchema,
  parseAgentInput,
  parseAgentRecord,
  parseAgentUpdate,
} from './platform/agent-definitions.js';
export type {
  AgentRecord,
  AgentRecordInput,
  AgentRecordLimits,
  AgentSkill,
  AgentUpdate,
} from './platform/agent-definitions.js';
export { assertMatches, InMemoryContentStore, locate, sha256Hex } from './content/content-store.js';
export type { ContentLocation, ContentStore, LoadedContent } from './content/content-store.js';
export { S3ContentStore } from './content/s3-content-store.js';
export type { S3ContentStoreOptions } from './content/s3-content-store.js';
export { parseS3Uri, S3_URI_PATTERN } from './content/s3-uri.js';
export type { S3Location } from './content/s3-uri.js';
export {
  parseSkillInput,
  parseSkillRecord,
  parseSkillUpdate,
  skillInputSchema,
  skillRecordSchema,
  skillUpdateSchema,
} from './platform/skill-definitions.js';
export type { SkillRecord, SkillRecordInput, SkillUpdate } from './platform/skill-definitions.js';
export { TempSkillDirectory } from './skills/temp-skill-directory.js';
export {
  SKILL_MAX_OBJECT_BYTES,
  SKILL_REQUEST_TIMEOUT_MS,
  SkillContentStores,
} from './platform/skill-content.js';
export type { SkillContentOptions } from './platform/skill-content.js';
export { PlatformAgentRegistry } from './platform/agent-registry.js';
export type {
  AgentLookup,
  AgentStores,
  PlatformAgentRegistryOptions,
  ResolvedAgent,
  SkillLookup,
} from './platform/agent-registry.js';
export {
  AGENT_RUNTIME_SUPPORT,
  assertAgentRuntimeSupport,
  MCP_TOOL_PREFIX,
  RESERVED_TOOL_NAMES,
} from './platform/agent-support.js';
export type {
  AgentRuntimeSupportCheckInput,
  HonouredAgentLimit,
  SupportedAgentTool,
} from './platform/agent-support.js';
export {
  headlessAgentSchema,
  headlessLimitsSchema,
  headlessMcpServerSchema,
  headlessModelProviderSchema,
  headlessPermissionRuleSchema,
  headlessSkillSchema,
  invocationAttachmentSchema,
  invocationPayloadSchema,
  parseInvocationPayload,
} from './headless/payload.js';
export type {
  HeadlessAgentSpec,
  HeadlessMcpServerSpec,
  HeadlessModelProviderSpec,
  HeadlessPermissionRule,
  HeadlessSkillSpec,
  InvocationPayload,
  InvocationPayloadInput,
} from './headless/payload.js';
export { resolveInlineAgent } from './headless/inline-agent.js';
export type { InlineAgentOptions } from './headless/inline-agent.js';
export {
  headlessToolCatalogue,
  invokeHeadless,
  parsePayload,
  streamHeadless,
} from './headless/invoke.js';
export type {
  HeadlessContextUsage,
  HeadlessResult,
  HeadlessResponse,
  HeadlessRunOptions,
  HeadlessSessionInfo,
  HeadlessToolSummary,
} from './headless/invoke.js';
export {
  AGENTCORE_RUNTIME_SESSION_HEADER,
  AWS_TRACE_HEADER,
  HEADLESS_HOST,
  HEADLESS_PORT,
  RUN_ID_HEADER,
  startHeadlessServer,
} from './headless/server.js';
export type { HeadlessServerOptions, RunningHeadlessServer } from './headless/server.js';
export { ResumeWindowExpiredError, RunRegistry } from './headless/run-registry.js';
export type { RunFactory, RunRecord, RunRegistryOptions } from './headless/run-registry.js';
export { AsyncEventQueue } from './core/event-queue.js';
