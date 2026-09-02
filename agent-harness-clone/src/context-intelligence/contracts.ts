import type { AgentMessage } from '../core/messages.js';
import type { ToolDescriptor, ToolKind } from '../tools/tool.js';

export type ISODateTime = string;
export type ContextScope = {
  userId?: string;
  applicationId?: string;
  tenantId?: string;
  conversationId: string;
  taskId: string;
  namespaces: readonly string[];
};

export type IntentEntity = {
  name: string;
  value: string;
  type?: string;
  required: boolean;
  confidence: number;
};

export type TemporalRequirement = {
  expression: string;
  start?: ISODateTime;
  end?: ISODateTime;
  asOf?: ISODateTime;
  timezone?: string;
  requiresCurrentData: boolean;
};

export type RequestInstructionSegments = {
  /** The user's outcome, without tool, policy, or formatting directives. */
  userIntent: string;
  /** Non-retrieval task constraints that still govern execution. */
  taskInstructions: readonly string[];
  /** Directions about where/how to retrieve, never copied into the query verbatim. */
  retrievalInstructions: readonly string[];
  /** System/tool/control-plane language excluded from retrieval. */
  systemToolInstructions: readonly string[];
  /** Context Intelligence control language excluded from retrieval. */
  contextControlInstructions?: readonly string[];
  /** Assertions about execution validity excluded from retrieval. */
  validationInstructions?: readonly string[];
  /** Requests to expose execution state or diagnostics, excluded from retrieval. */
  reportingInstructions?: readonly string[];
  /** Output-shape directions excluded from retrieval. */
  formattingInstructions: readonly string[];
  /** Subject matter that evidence must answer. */
  informationRequirements: readonly string[];
};

/** Authoritative semantic value passed from a Context Need into retrieval planning. */
export type NormalizedRetrievalRequest = {
  /** The stable information need from which every attempt is derived. */
  informationNeed: string;
  /** The clean initial retrieval request. Adapted attempts derive from, but do not replace, it. */
  request: string;
};

export type NormalizedIntent = {
  originalRequest: string;
  /** A clean information query, not the complete execution prompt. */
  normalizedRequest: string;
  goal: string;
  operation: 'answer' | 'analyze' | 'create' | 'update' | 'delete' | 'execute' | 'unknown';
  requestedOutput?: string;
  entities: readonly IntentEntity[];
  constraints: readonly string[];
  temporal?: TemporalRequirement;
  ambiguity: readonly string[];
  keywords: readonly string[];
  complexity: 'simple' | 'compound' | 'complex';
  confidence: number;
  instructionSegments: RequestInstructionSegments;
};

/** Source-independent vocabulary used for need, evidence, and capability decisions. */
export type ContextSourceKind =
  | 'FILE'
  | 'WEB'
  | 'MEMORY'
  | 'MCP'
  | 'DATABASE'
  | 'API'
  | 'TASK_STATE'
  | 'ARTIFACT'
  | 'APPLICATION_CONTEXT';

/** Generic information/capability vocabulary owned by Context Intelligence. */
export type ContextNeedType =
  | 'CURRENT_EXTERNAL_INFORMATION'
  | 'FILE_INFORMATION'
  | 'DATABASE_INFORMATION'
  | 'API_INFORMATION'
  | 'MCP_DOMAIN_INFORMATION'
  | 'MEMORY_INFORMATION'
  | 'TASK_STATE_INFORMATION'
  | 'ARTIFACT_INFORMATION'
  | 'APPLICATION_CONTEXT_INFORMATION'
  | 'DOCUMENT_CREATION';

export type ContextCapability =
  | 'WEB_RETRIEVAL'
  | 'WEB_SEARCH'
  | 'WEB_FETCH'
  | 'FILE_DISCOVERY'
  | 'FILE_READ'
  | 'ARTIFACT_DISCOVERY'
  | 'DATABASE_QUERY'
  | 'API_RETRIEVAL'
  | 'MCP_RETRIEVAL'
  | 'MEMORY_RECALL'
  | 'TASK_STATE_READ'
  | 'ARTIFACT_READ'
  | 'APPLICATION_CONTEXT_READ'
  | 'MARKDOWN_ARTIFACT_CREATE'
  | 'DOCUMENT_ARTIFACT_CREATE';

export type ExecutableContextCapability = Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
export type ContextFreshnessRequirement =
  'CURRENT' | 'LATEST' | 'RECENT' | 'TODAY' | 'THIS_WEEK' | 'HISTORICAL' | 'ANY' | 'NONE';
export type ContextAuthorityRequirement = 'AUTHORITATIVE' | 'TRUSTED' | 'ANY';
export type ContextSourceRequirement =
  | 'external'
  | 'workspace'
  | 'memory'
  | 'mcp'
  | 'database'
  | 'api'
  | 'task-state'
  | 'artifact'
  | 'application-context'
  | 'any';

export type CapabilityRequirement = {
  id: string;
  needId: string;
  capability: ContextCapability;
  /** Read-only capabilities that must run before acquisition can be planned safely. */
  prerequisiteCapabilities?: readonly ExecutableContextCapability[];
  /** Source-compatible acquisition capabilities; these are never cross-source fallbacks. */
  alternativeCapabilities?: readonly ExecutableContextCapability[];
  sourceKinds: readonly ContextSourceKind[];
  readOnly: boolean;
  requiredInputs: readonly string[];
  authorityRequirement: ContextAuthorityRequirement;
  freshnessRequirement: ContextFreshnessRequirement;
};

export type ContextNeedStatus = 'satisfied' | 'missing' | 'unavailable' | 'clarification_required';

export type ContextNeed = {
  id: string;
  type: ContextNeedType;
  required: boolean;
  requiredInformation: readonly string[];
  missingInformation: readonly string[];
  reason: string;
  sourceRequirement: ContextSourceRequirement;
  sourceKinds: readonly ContextSourceKind[];
  freshnessRequirement: ContextFreshnessRequirement;
  authorityRequirement: ContextAuthorityRequirement;
  scope: ContextScope;
  evidenceRequirement: 'REQUIRED' | 'SUPPORTING' | 'NONE';
  requiredCapability: ContextCapability;
  capabilityRequirement: CapabilityRequirement;
  priority: 'critical' | 'high' | 'normal' | 'low';
  status: ContextNeedStatus;
  /** Validated arguments with real provenance, or safe abstract query inputs. */
  inputs: Readonly<Record<string, unknown>>;
  /** Canonical semantic request consumed by retrieval planning; never reconstructed from raw input. */
  normalizedRetrievalRequest?: NormalizedRetrievalRequest;
};

export type SourceType =
  | 'user'
  | 'conversation'
  | 'memory'
  | 'file'
  | 'web'
  | 'mcp'
  | 'database'
  | 'api'
  | 'task-state'
  | 'artifact'
  | 'application-context'
  | 'document'
  | 'structured'
  | 'vector'
  | 'semantic'
  | 'keyword'
  | 'hybrid'
  | 'tool'
  | 'external'
  | 'derived';

export type SourceMetadata = {
  id: string;
  name: string;
  type: SourceType;
  sourceKind?: ContextSourceKind;
  provider?: string;
  authority: number;
  retrievedAt?: ISODateTime;
  observedAt?: ISODateTime;
  /** Timestamp asserted by the source, distinct from retrieval time. */
  sourceTimestamp?: ISODateTime;
  validFrom?: ISODateTime;
  validUntil?: ISODateTime;
  version?: string;
  scope?: readonly string[];
  uri?: string;
  contentHash?: string;
  extractionContext?: string;
  evidenceIdentity?: string;
  policyLabels?: readonly string[];
};

export type ProvenanceStep = {
  operation:
    | 'received'
    | 'recalled'
    | 'retrieved'
    | 'rewritten'
    | 'expanded'
    | 'decomposed'
    | 'filtered'
    | 'ranked'
    | 'reranked'
    | 'shaped'
    | 'summarized'
    | 'compressed'
    | 'offloaded'
    | 'synthesized'
    | 'validated';
  at: ISODateTime;
  component: string;
  inputIds: readonly string[];
  details?: Readonly<Record<string, unknown>>;
};

export type Provenance = {
  id: string;
  source: SourceMetadata;
  steps: readonly ProvenanceStep[];
  parentIds: readonly string[];
};

export type ContextItemKind =
  | 'instruction'
  | 'request'
  | 'history'
  | 'task-state'
  | 'memory'
  | 'evidence'
  | 'observation'
  | 'finding'
  | 'constraint'
  | 'policy'
  | 'example'
  | 'artifact-handle';

export type ContextLifecycleState =
  | 'discovered'
  | 'retrieved'
  | 'observed'
  | 'evaluated'
  | 'admitted'
  | 'ranked'
  | 'used'
  | 'compressed'
  | 'offloaded'
  | 'recalled'
  | 'archived';

export type ContextItem = {
  id: string;
  kind: ContextItemKind;
  title?: string;
  content: string;
  structured?: unknown;
  source: SourceMetadata;
  provenance: Provenance;
  /** Provenance records folded into this strongest representation during deduplication. */
  supportingProvenanceIds?: readonly string[];
  dependencyIds?: readonly string[];
  lifecycleState?: ContextLifecycleState;
  relevance: number;
  confidence: number;
  authority: number;
  freshness: number;
  priority: 'essential' | 'high' | 'normal' | 'low';
  tokenEstimate: number;
  createdAt: ISODateTime;
  expiresAt?: ISODateTime;
  supersedes?: readonly string[];
  claimKeys?: readonly string[];
  policyLabels?: readonly string[];
  active: boolean;
};

export type EvidenceRelationship = 'supports' | 'contradicts' | 'context' | 'discovery';

export type EvidenceItem = ContextItem & {
  kind: 'evidence';
  claims: readonly string[];
  retrievalQuery?: string;
  /** Passive-provider result identity retained for event-derived feedback correlation. */
  retrievalResultId?: string;
  rank: number;
  capability?: ContextCapability;
  observationId?: string;
  evidenceIdentity: string;
  relationship: EvidenceRelationship;
  evaluation: {
    relevance: number;
    authority: number;
    freshness: number;
    confidence: number;
    provenanceComplete: boolean;
    admitted: boolean;
    reasons: readonly string[];
  };
};

export type EvidenceGroup = {
  id: string;
  claimKey: string;
  evidenceIds: readonly string[];
  provenanceIds: readonly string[];
  strongestEvidenceId: string;
  duplicateCount: number;
  relationships: Readonly<Partial<Record<EvidenceRelationship, number>>>;
};

export type ContextConflict = {
  id: string;
  claimKey: string;
  itemIds: readonly string[];
  reason: 'value' | 'scope' | 'time' | 'version' | 'authority';
  resolution: 'authority' | 'freshness' | 'scope' | 'version' | 'unresolved';
  resolutionStatus: 'resolved' | 'unresolved' | 'requires_clarification';
  preferredItemId?: string;
  claims: readonly {
    itemId: string;
    value: string;
    sourceId: string;
    sourceTimestamp?: ISODateTime;
    sourceVersion?: string;
    sourceScope?: readonly string[];
    authority: number;
  }[];
  explanation: string;
};

/** Truthful outcome of an attempted operation, independent of task completion. */
export type ExecutionState = 'SUCCESS' | 'EMPTY' | 'FAILED' | 'BLOCKED' | 'NOT_EXECUTED';

/** Resource state keeps discovery truth separate from acquisition failures. */
export type ResourceState =
  | 'FOUND'
  | 'VERIFIED_MISSING'
  | 'NOT_CHECKED'
  | 'RETRIEVAL_FAILED'
  | 'RETRIEVED_EMPTY'
  | 'RETRIEVED_SUCCESSFULLY';

export type ResourceCandidate = {
  sourceKind: Extract<ContextSourceKind, 'FILE' | 'ARTIFACT'>;
  identifier: string;
  name?: string;
  uri?: string;
  path?: string;
  artifactId?: string;
  scope: readonly string[];
  discoveredBy: 'runtime_tool' | 'conversation_metadata' | 'context_offload';
  discoveredAt: ISODateTime;
};

export type ResourceRecord = {
  id: string;
  requestId: string;
  needId: string;
  reference: string;
  sourceKind: Extract<ContextSourceKind, 'FILE' | 'ARTIFACT'>;
  state: ResourceState;
  candidates: readonly ResourceCandidate[];
  discoveryOperationIds: readonly string[];
  retrievalOperationIds: readonly string[];
  checkedScope?: string;
  reason: string;
  updatedAt: ISODateTime;
};

export type TaskExecutionRecord = {
  operationId?: string;
  receiptId?: string;
  stepId?: string;
  state: ExecutionState;
  disposition: 'COMPLETED' | 'COMPLETED_WITH_NO_EVIDENCE' | 'FAILED' | 'BLOCKED' | 'NOT_EXECUTED';
  reason?: string;
  at: ISODateTime;
};

export type TaskStep = {
  id: string;
  description: string;
  status:
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'completed_with_no_evidence'
    | 'failed'
    | 'blocked'
    | 'not_executed';
  dependencies: readonly string[];
  attempts: number;
  evidenceIds: readonly string[];
  receiptIds: readonly string[];
  lastExecutionState?: ExecutionState;
  updatedAt: ISODateTime;
};

export type TaskFailureAttempt = {
  operationId?: string;
  receiptId?: string;
  stepId?: string;
  executionState?: Extract<ExecutionState, 'FAILED' | 'BLOCKED'>;
  reason: string;
  at: ISODateTime;
};

export type TaskDependency = {
  id: string;
  dependsOn: readonly string[];
  status: 'pending' | 'ready' | 'blocked' | 'satisfied';
};

export type TaskState = {
  taskId: string;
  goal: string;
  objective: string;
  currentPhase: string;
  scope: readonly string[];
  plan: readonly TaskStep[];
  completedSteps: readonly string[];
  pendingSteps: readonly string[];
  completedWork: readonly string[];
  pendingWork: readonly string[];
  retrievedEvidence: readonly string[];
  constraints: readonly string[];
  confirmations: readonly string[];
  retries: number;
  receipts: readonly string[];
  unresolvedIssues: readonly string[];
  unresolvedQuestions: readonly string[];
  failedAttempts: readonly TaskFailureAttempt[];
  executionHistory: readonly TaskExecutionRecord[];
  successfulOperations: readonly string[];
  emptyOperations: readonly string[];
  failedOperations: readonly string[];
  blockedOperations: readonly string[];
  notExecutedOperations: readonly string[];
  pendingOperation?: string;
  decisions: readonly string[];
  pendingDecisions: readonly string[];
  dependencies: readonly TaskDependency[];
  nextAction?: string;
  variables: Readonly<Record<string, unknown>>;
  status: 'active' | 'completed' | 'blocked' | 'failed';
  updatedAt: ISODateTime;
};

export type MemoryType = 'short-term' | 'working' | 'semantic' | 'procedural' | 'episodic';
export type MemoryLayer = 'working' | 'task' | 'long-term';
export type MemoryLifecycleStatus = 'active' | 'superseded' | 'expired' | 'deleted';

export type MemoryItem = {
  id: string;
  type: MemoryType;
  layer?: MemoryLayer;
  scope: ContextScope;
  content: string;
  structured?: unknown;
  labels: readonly string[];
  entities: readonly string[];
  relevance: number;
  confidence: number;
  authority: number;
  durability: number;
  usefulness: number;
  privacy: 'public' | 'internal' | 'confidential' | 'restricted';
  provenance: Provenance;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  lastAccessedAt?: ISODateTime;
  expiresAt?: ISODateTime;
  version: number;
  status: MemoryLifecycleStatus;
  supersedes?: string;
  conflictsWithEvidenceIds?: readonly string[];
  retentionDecision?: 'retain' | 'ignore_stale' | 'ignore_conflict' | 'ignore_irrelevant';
};

export type MemoryRecallAssessment = {
  retained: readonly MemoryItem[];
  ignoredIds: readonly string[];
  staleIds: readonly string[];
  conflictingIds: readonly string[];
};

export type MemoryAdmissionDecision = {
  action: 'approve' | 'reject' | 'update' | 'supersede' | 'merge';
  candidate: MemoryItem;
  reason: string;
  existingId?: string;
};

export type QueryStatus =
  'pending' | 'running' | 'sufficient' | 'insufficient' | 'failed' | 'skipped';
export type QueryVariant = {
  id: string;
  parentId?: string;
  original: string;
  query: string;
  kind: 'original' | 'rewrite' | 'expansion' | 'subquery' | 'refinement';
  dependencyIds: readonly string[];
  expectedEvidence: readonly string[];
  sourceHints: readonly string[];
  status: QueryStatus;
  resultIds: readonly string[];
  attempts: number;
};

export type QueryPlan = {
  id: string;
  originalRequest: string;
  normalizedQuery: string;
  variants: readonly QueryVariant[];
  synthesisOrder: readonly string[];
  createdAt: ISODateTime;
};

export type RetrievalMode =
  'structured' | 'document' | 'vector' | 'semantic' | 'keyword' | 'hybrid' | 'external';

export type RetrievalProviderMetadata = {
  id: string;
  name: string;
  modes: readonly RetrievalMode[];
  source: SourceMetadata;
  description: string;
  collections: readonly string[];
  entityTypes: readonly string[];
  supportsFilters: boolean;
  supportsProjection: boolean;
  supportsAggregation: boolean;
  cost: number;
  latency: number;
  enabled: boolean;
  /**
   * Passive providers expose already-authorized in-process context. Providers marked
   * runtime_tool are discovery metadata only; acquisition must be planned as a
   * normal AgentSession tool action and is never invoked by this interface.
   */
  executionBoundary?: 'passive_context' | 'runtime_tool';
};

export type RetrievalRequest = {
  query: QueryVariant;
  intent: NormalizedIntent;
  scope: ContextScope;
  mode?: RetrievalMode;
  collection?: string;
  filters?: Readonly<Record<string, unknown>>;
  projection?: readonly string[];
  limit: number;
  signal: AbortSignal;
};

export type RetrievalResult = {
  id: string;
  providerId: string;
  queryId: string;
  content: string;
  structured?: unknown;
  source: SourceMetadata;
  provenance: Provenance;
  relevance: number;
  confidence: number;
  authority: number;
  freshness: number;
  claimKeys: readonly string[];
  claims: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
};

export interface RetrievalProvider {
  readonly metadata: RetrievalProviderMetadata;
  retrieve(request: RetrievalRequest): Promise<readonly RetrievalResult[]>;
}

export interface RetrievalReranker {
  rerank(
    intent: NormalizedIntent,
    results: readonly RetrievalResult[],
    signal: AbortSignal,
  ): Promise<readonly RetrievalResult[]>;
}

export type RetrievalIteration = {
  iteration: number;
  queryIds: readonly string[];
  providerIds: readonly string[];
  resultCount: number;
  acceptedCount: number;
  sufficient: boolean;
  reason: string;
  durationMs: number;
};

export type RetrievalOutcome = {
  results: readonly RetrievalResult[];
  iterations: readonly RetrievalIteration[];
  conflicts: readonly ContextConflict[];
  sufficient: boolean;
  insufficiencies: readonly string[];
};

export type CapabilityMetadata = {
  id: string;
  name: string;
  description: string;
  kind: ToolKind | 'retrieval' | 'memory' | 'model';
  keywords: readonly string[];
  entityTypes: readonly string[];
  operations: readonly string[];
  sourceIds: readonly string[];
  sourceKinds?: readonly ContextSourceKind[];
  authority: number;
  cost: number;
  latency: number;
  preconditions: readonly string[];
  effects: readonly string[];
  limitations: readonly string[];
  policyLabels: readonly string[];
  enabled: boolean;
  /** Generic capabilities implemented by this concrete runtime tool. */
  provides?: readonly ContextCapability[];
  /** Optional generic-to-concrete argument aliases declared by the host. */
  inputAliases?: Readonly<Record<string, string>>;
  /**
   * Optional upper bound on text query length for this capability, in characters.
   * Used by the retrieval planner as a fallback when the tool's JSON schema does not
   * declare maxLength on the primary query argument.  Set by capability registration;
   * never inferred automatically so as not to fabricate constraints that are not
   * declared by the actual capability or its tool schema.
   */
  maximumQueryLength?: number;
};

export type CapabilityResolution = {
  needId: string;
  requested: ContextCapability;
  requiredCapabilities: readonly ContextCapability[];
  permittedCapabilities?: readonly ExecutableContextCapability[];
  status: 'available' | 'unavailable';
  toolNames: readonly string[];
  alternatives: Readonly<Partial<Record<ExecutableContextCapability, readonly string[]>>>;
  selectionBasis?: 'declared_order' | 'observed_performance';
  reason: string;
};

export type SelectedCapability = {
  capability: CapabilityMetadata;
  score: number;
  reasons: readonly string[];
  descriptor?: ToolDescriptor;
};

export type ToolPlan = {
  goal: string;
  selected: readonly SelectedCapability[];
  excluded: readonly { name: string; reason: string }[];
  argumentRequirements: Readonly<Record<string, readonly string[]>>;
  requirements: readonly CapabilityRequirement[];
  resolutions: readonly CapabilityResolution[];
};

export type RetrievalInputTrace = {
  /** Semantic information need from which the tool argument was constructed. */
  informationNeed: string;
  /** Exact bounded value supplied to the selected capability. */
  retrievalRequest: string;
  argumentName: string;
  construction:
    'normalized_intent' | 'query_variant' | 'decomposed_information_need' | 'semantic_compaction';
  semanticallyCompacted: boolean;
  capabilityMaximumLength?: number;
};

export type RetrievalSourceLineage = {
  /** The trusted runtime origin for a fetch URL. */
  origin: 'SEARCH_RESULT' | 'USER_REQUEST';
  selectedUrl: string;
  sourceOperationId?: string;
  sourceObservationId?: string;
};

export type RetrievalStrategyChange = {
  previousOperationId: string;
  previousStrategy: RetrievalAdaptationStrategy;
  nextStrategy: RetrievalAdaptationStrategy;
  strategyChanged: boolean;
  normalizedRequestChanged: boolean;
  capabilityChanged: boolean;
  toolChanged: boolean;
  actualInputChanged: boolean;
  meaningful: boolean;
  differences: readonly string[];
};

export type ContextRuntimeAction = {
  id: string;
  /** Immutable identity of the normalized plan that authorized this attempt. */
  retrievalPlanId: string;
  requestId: string;
  needId: string;
  capability: ExecutableContextCapability;
  phase: 'discovery' | 'retrieval';
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  /** Stable fingerprint used to prevent identical failed retries. */
  attemptKey: string;
  reason: string;
  strategy: RetrievalAdaptationStrategy;
  retrievalInput?: RetrievalInputTrace;
  sourceLineage?: RetrievalSourceLineage;
  /** Why this strategy is preferable to repeating the prior attempt. */
  adaptationReason?: string;
  previousStrategy?: RetrievalAdaptationStrategy;
  iteration: number;
  priorOperationIds: readonly string[];
};

/** Generic result of evaluating one retrieval attempt. */
export type RetrievalOutcomeClassification =
  | 'NO_RESULT'
  | 'EMPTY_RESULT'
  | 'LOW_RELEVANCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'STALE_EVIDENCE'
  | 'SOURCE_CONFLICT'
  | 'TOOL_FAILURE'
  | 'ACCESS_FAILURE'
  | 'INVALID_REFERENCE'
  | 'RETRIEVAL_SUCCESS';

/**
 * Strategy vocabulary for Priority 1. Query transformations are intentionally
 * abstract here; deeper rewrite intelligence remains outside this layer.
 */
export type RetrievalAdaptationStrategy =
  | 'INITIAL'
  | 'QUERY_REWRITE'
  | 'QUERY_EXPANSION'
  | 'QUERY_DECOMPOSITION'
  | 'SOURCE_SWITCH'
  | 'RETRIEVAL_BROADEN'
  | 'RETRIEVAL_NARROW'
  | 'ADDITIONAL_EVIDENCE'
  | 'TRANSIENT_RETRY';

export type RetrievalState =
  | 'NOT_EXECUTED'
  | 'IN_PROGRESS'
  | 'SUCCESS'
  | 'EMPTY'
  | 'FAILED'
  | 'RETRYING'
  | 'EXHAUSTED'
  | 'BLOCKED';

export type RetrievalTerminationReason =
  | 'SUFFICIENT_EVIDENCE'
  | 'GROUNDING_SATISFIED'
  | 'RETRIEVAL_BUDGET_EXHAUSTED'
  | 'NO_USEFUL_ADAPTATION'
  | 'CLARIFICATION_REQUIRED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'ACCESS_BLOCKED'
  | 'INVALID_REFERENCE'
  | 'UNRESOLVED_SOURCE_CONFLICT'
  | 'SAFE_CONTINUATION_IMPOSSIBLE';

/** Values are present only when they were measured by the evidence layer. */
export type RetrievalEvidenceQuality = {
  evidenceCount: number;
  relevance?: number;
  authority?: number;
  freshness?: number;
  /** Fraction of required Context Needs closed by evaluated evidence. */
  completeness: number;
  confidence?: number;
  provenanceCompleteness?: number;
  conflictCount: number;
  sufficient: boolean;
};

export type RetrievalAttemptAssessment = {
  operationId: string;
  needId: string;
  attemptNumber: number;
  state: RetrievalState;
  capability: ExecutableContextCapability;
  toolName: string;
  strategy: RetrievalAdaptationStrategy;
  outcome?: RetrievalOutcomeClassification;
  reason: string;
  adaptationReason?: string;
  previousStrategy?: RetrievalAdaptationStrategy;
  nextStrategy?: RetrievalAdaptationStrategy;
  strategyChange?: RetrievalStrategyChange;
  remainingRetrievalBudget: number;
  evidenceQuality: RetrievalEvidenceQuality;
  contributedEvidence: boolean;
  terminationReason?: RetrievalTerminationReason;
};

export type RetrievalNeedAssessment = {
  needId: string;
  state: RetrievalState;
  outcome?: RetrievalOutcomeClassification;
  recommendedStrategies: readonly RetrievalAdaptationStrategy[];
  adaptationReason?: string;
  terminationReason?: RetrievalTerminationReason;
};

export type AdaptiveRetrievalSummary = {
  state: RetrievalState;
  attemptCount: number;
  remainingRetrievalBudget: number;
  attempts: readonly RetrievalAttemptAssessment[];
  needs: readonly RetrievalNeedAssessment[];
  evidenceQuality: RetrievalEvidenceQuality;
  terminationReason?: RetrievalTerminationReason;
};

export type ToolFailureClassification =
  | 'authorization_denied'
  | 'invalid_input'
  | 'not_found'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unsupported'
  | 'irrelevant'
  | 'empty'
  | 'malformed'
  | 'unknown';

export type ObservedCost = {
  amount: number;
  unit: string;
  source: 'tool_result_metadata' | 'runtime_event';
};

export type RuntimeRetrievalOperation = {
  /** Authoritative retrieval-attempt identity. */
  id: string;
  /** Immutable identity of the normalized plan that authorized this attempt. */
  retrievalPlanId: string;
  requestId: string;
  needId: string;
  capability: ExecutableContextCapability;
  phase: ContextRuntimeAction['phase'];
  toolName: string;
  /** Capability input planned and validated by Context Intelligence. */
  input: Readonly<Record<string, unknown>>;
  /** Exact schema-parsed input passed to tool.execute; absent when execution never started. */
  actualInput?: unknown;
  /** Set at the invocation boundary immediately before tool.execute is called. */
  invokedAt?: ISODateTime;
  /** Exact value returned by tool.execute, before observation shaping or offloading. */
  actualResult?: {
    content: string;
    isError?: boolean;
    metadata?: Readonly<Record<string, unknown>>;
  };
  /** Set when tool.execute resolves with actualResult. */
  resultReceivedAt?: ISODateTime;
  attemptKey: string;
  strategy: RetrievalAdaptationStrategy;
  retrievalInput?: RetrievalInputTrace;
  sourceLineage?: RetrievalSourceLineage;
  /** IDs of prior attempts for this need, captured when the plan was created. */
  priorOperationIds: readonly string[];
  adaptationReason?: string;
  previousStrategy?: RetrievalAdaptationStrategy;
  nextStrategy?: RetrievalAdaptationStrategy;
  /** Computed only from actual attempt inputs at the invocation boundary. */
  strategyChange?: RetrievalStrategyChange;
  iteration: number;
  status: 'planned' | 'succeeded' | 'empty' | 'failed' | 'denied';
  executionState: ExecutionState;
  resourceState: ResourceState;
  resourceCandidates?: readonly ResourceCandidate[];
  failureClassification?: ToolFailureClassification;
  retrievalResult?: RetrievalOutcomeClassification;
  retrievalState?: RetrievalState;
  remainingRetrievalBudget?: number;
  evidenceQuality?: RetrievalEvidenceQuality;
  contributedEvidence?: boolean;
  terminationReason?: RetrievalTerminationReason;
  observationId?: string;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  /** End-to-end latency from planning until the observation was recorded. */
  durationMs?: number;
  /** Tool execution time supplied by the runtime; never estimated by Context Intelligence. */
  executionDurationMs?: number;
  /** Explicit cost accounting supplied by the runtime/tool, if available. */
  observedCost?: ObservedCost;
};

export type ToolOutcome = 'success' | 'empty' | 'partial' | 'error' | 'denied' | 'malformed';
export type ToolObservation = {
  id: string;
  toolCallId: string;
  toolName: string;
  outcome: ToolOutcome;
  content: string;
  structured?: unknown;
  facts: readonly string[];
  identifiers: readonly string[];
  errors: readonly string[];
  source: SourceMetadata;
  provenance: Provenance;
  artifactId?: string;
  requiresFollowUp: boolean;
  followUpReason?: string;
  failureClassification?: ToolFailureClassification;
  createdAt: ISODateTime;
  requestId?: string;
  needIds?: readonly string[];
  capability?: ExecutableContextCapability;
  links?: readonly string[];
};

export type OffloadedArtifact = {
  id: string;
  artifactId: string;
  originalItemId?: string;
  kind: 'tool-result' | 'document' | 'observation' | 'intermediate' | 'history';
  summary: string;
  size: number;
  contentType: string;
  reference: string;
  recall: {
    capability: 'ARTIFACT_READ';
    inputs: Readonly<{ artifactId: string; referenceOrigin: 'context_offload' }>;
  };
  source: SourceMetadata;
  provenance: Provenance;
  lifecycleState: 'offloaded' | 'recalled' | 'archived';
  createdAt: ISODateTime;
};

export type CrossDocumentSynthesis = {
  id: string;
  sourceIds: readonly string[];
  itemIds: readonly string[];
  evidenceIds: readonly string[];
  claimGroups: readonly {
    claimKey: string;
    itemIds: readonly string[];
    sourceIds: readonly string[];
  }[];
  conflictIds: readonly string[];
  summary: string;
  provenance: Provenance;
  createdAt: ISODateTime;
};

export type ContextLifecycleEvent = {
  id: string;
  requestId: string;
  itemId?: string;
  needId?: string;
  from?: ContextLifecycleState;
  to: ContextLifecycleState;
  reason: string;
  component: string;
  metadata: Readonly<Record<string, unknown>>;
  at: ISODateTime;
};

export type ContextFeedbackCategory =
  'retrieval' | 'tool_choice' | 'memory' | 'overflow' | 'quality_gate';

export type ContextFeedbackOutcome =
  | 'useful'
  | 'irrelevant'
  | 'failed'
  | 'duplicate'
  | 'retained'
  | 'ignored_stale'
  | 'ignored_conflict'
  | 'omitted'
  | 'offloaded'
  | 'rejected';

export type ContextFeedbackReference = {
  kind:
    | 'operation'
    | 'observation'
    | 'evidence'
    | 'retrieval_result'
    | 'memory'
    | 'context_item'
    | 'evidence_group'
    | 'finalization'
    | 'quality_decision';
  id: string;
};

/** Bounded, content-free feedback grounded in concrete lifecycle/runtime facts. */
export type ContextFeedbackRecord = {
  id: string;
  requestId: string;
  category: ContextFeedbackCategory;
  outcome: ContextFeedbackOutcome;
  reasonCode: string;
  operationId?: string;
  observationId?: string;
  evidenceId?: string;
  retrievalResultId?: string;
  memoryId?: string;
  toolName?: string;
  capability?: ExecutableContextCapability;
  sourceReferences: readonly ContextFeedbackReference[];
  at: ISODateTime;
};

export type RuntimePerformanceProfile = {
  toolName: string;
  capability: ExecutableContextCapability;
  completedSamples: number;
  succeededSamples: number;
  usefulSamples: number;
  irrelevantSamples: number;
  failedSamples: number;
  duplicateSamples: number;
  classifiedSamples: number;
  durationSamples: number;
  totalDurationMs: number;
  observedCosts: readonly {
    unit: string;
    samples: number;
    total: number;
  }[];
  processedOperationIds: readonly string[];
  updatedAt: ISODateTime;
};

export type RuntimeOptimizationSummary = {
  enabled: boolean;
  eligibleProfiles: number;
  reorderedSelections: number;
  durationSamples: number;
  costSamples: number;
  unavailableReason?:
    'disabled' | 'no_runtime_operations' | 'insufficient_comparable_samples' | 'no_observed_cost';
};

export type PredictiveContextProjection = {
  readyStepIds: readonly string[];
  satisfiedDependencyIds: readonly string[];
  evidenceIds: readonly string[];
  truncated: boolean;
  generatedAt: ISODateTime;
};

export type MeasuredRatio = {
  numerator: number;
  denominator: number;
  value: number;
};

export type ContextEvaluationSnapshot = {
  operationSuccess?: MeasuredRatio;
  classifiedRetrievalUsefulness?: MeasuredRatio;
  evidenceUtilization?: MeasuredRatio;
  memoryRetention?: MeasuredRatio;
  gateRejection?: MeasuredRatio;
  unclassifiedRetrievalOperations: number;
  latency: {
    samples: number;
    totalMs: number;
    meanMs?: number;
    minimumMs?: number;
    maximumMs?: number;
  };
  costs: readonly {
    unit: string;
    samples: number;
    total: number;
  }[];
  unavailable: readonly {
    metric: 'retrieval_recall' | 'answer_accuracy' | 'observed_cost';
    reason: 'no_relevance_ground_truth' | 'no_accuracy_ground_truth' | 'no_observed_cost';
  }[];
  evaluatedAt: ISODateTime;
};

export type ContextBudgetCategory =
  | 'systemInstructions'
  | 'taskInstructions'
  | 'userRequest'
  | 'conversationHistory'
  | 'memory'
  | 'retrievalEvidence'
  | 'toolObservations'
  | 'toolDefinitions'
  | 'taskState'
  | 'safetyPolicy';

export type ContextBudgetAllocation = {
  category: ContextBudgetCategory;
  maximumTokens: number;
  usedTokens: number;
  priority: number;
};

export type ContextBudgetSnapshot = {
  inputLimit: number;
  outputReservation: number;
  safetyMargin: number;
  availableInput: number;
  usedInput: number;
  allocations: readonly ContextBudgetAllocation[];
  exceeded: boolean;
};

export type ContextQualityStatus = 'passed' | 'degraded' | 'insufficient' | 'rejected';
export type QualityIssueCode =
  | 'irrelevant'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'low_authority'
  | 'missing_provenance'
  | 'missing_evidence'
  | 'oversized'
  | 'out_of_scope'
  | 'policy'
  | 'poisoning'
  | 'budget';

export type ContextQualityIssue = {
  code: QualityIssueCode;
  severity: 'info' | 'warning' | 'error';
  itemIds: readonly string[];
  message: string;
  remediation: 'retain' | 'prune' | 'compress' | 'replace' | 'retrieve' | 'clarify' | 'reject';
};

export type ContextQualityReport = {
  status: ContextQualityStatus;
  decision: ContextQualityDecision;
  score: number;
  issues: readonly ContextQualityIssue[];
  conflicts: readonly ContextConflict[];
  sufficient: boolean;
  checkedAt: ISODateTime;
};

export type ContextQualityDecision =
  'ACCEPT' | 'RETRIEVE' | 'RETRIEVE_AGAIN' | 'CLARIFY' | 'CONFLICT' | 'DENY' | 'ABSTAIN';

export type ContextRuntimeDirective = {
  decision: ContextQualityDecision;
  continueToModel: boolean;
  actions: readonly ContextRuntimeAction[];
  reasonCodes: readonly string[];
  clarification: readonly {
    needId: string;
    type: ContextNeedType;
    missingInformation: readonly string[];
  }[];
};

export type FinalContextSection = {
  category: ContextBudgetCategory;
  title: string;
  content: string;
  itemIds: readonly string[];
  tokenEstimate: number;
  priority: number;
};

export type FinalizedContext = {
  systemPromptAddition: string;
  messages: readonly AgentMessage[];
  tools: readonly ToolDescriptor[];
  sections: readonly FinalContextSection[];
  budget: ContextBudgetSnapshot;
  quality: ContextQualityReport;
  /** Full governed item identities remain canonical outside the model request. */
  canonicalItemIds: readonly string[];
  /** Only these item identities were admitted to this model decision. */
  activeItemIds: readonly string[];
  criticalEvidenceIds: readonly string[];
  provenanceIds: readonly string[];
  omittedItemIds: readonly string[];
  omittedMessageIds: readonly string[];
  offloadedArtifacts: readonly OffloadedArtifact[];
};

export type ReasoningSupport = {
  mode: 'direct' | 'react' | 'alternatives' | 'tree';
  examples: readonly { input: string; output: string }[];
  alternatives: readonly { id: string; description: string; score: number; selected: boolean }[];
  plan: readonly string[];
  decisions: readonly string[];
  unresolvedIssues: readonly string[];
};

export type GroundingEvidenceReference = {
  evidenceId: string;
  observationId: string;
  operationId: string;
  provenanceId: string;
  sourceId: string;
  sourceName: string;
  sourceUri?: string;
};

export type GroundingClaimAssessment = {
  claimId: string;
  claim: string;
  supported: boolean;
  evidenceReferences: readonly GroundingEvidenceReference[];
};

export type GroundingAssessment = {
  status: 'NOT_EVALUATED' | 'NOT_REQUIRED' | 'PASS' | 'FAIL';
  required: boolean;
  decision?: Extract<ContextQualityDecision, 'ACCEPT' | 'CLARIFY' | 'ABSTAIN'>;
  claimCount: number;
  supportedClaimCount: number;
  unsupportedClaimIds: readonly string[];
  claims: readonly GroundingClaimAssessment[];
  claimsTruncated?: boolean;
  supportingEvidenceReferences: readonly GroundingEvidenceReference[];
  reasonCodes: readonly string[];
  checkedAt?: ISODateTime;
};

export type ContextIntelligenceAttemptTrace = {
  attemptId: string;
  retrievalPlanId: string;
  attemptNumber: number;
  needId: string;
  informationNeed?: string;
  normalizedRequest?: string;
  capability: ExecutableContextCapability;
  toolName: string;
  strategy: RetrievalAdaptationStrategy;
  plannedToolInput: Readonly<Record<string, unknown>>;
  actualToolInput?: unknown;
  actualToolResult?: RuntimeRetrievalOperation['actualResult'];
  invokedAt?: ISODateTime;
  resultReceivedAt?: ISODateTime;
  executionState: ExecutionState;
  retrievalState?: RetrievalState;
  observation?: {
    observationId: string;
    outcome: ToolOutcome;
    content: string;
    structured?: unknown;
    source: SourceMetadata;
    provenanceId: string;
  };
  classification?: RetrievalOutcomeClassification;
  evidence: readonly {
    evidenceId: string;
    observationId?: string;
    provenanceId: string;
    source: SourceMetadata;
    admitted: boolean;
  }[];
  evidenceQuality?: RetrievalEvidenceQuality;
  sufficient: boolean;
  adaptationReason?: string;
  previousStrategy?: RetrievalAdaptationStrategy;
  nextStrategy?: RetrievalAdaptationStrategy;
  strategyChange?: RetrievalStrategyChange;
  sourceLineage?: RetrievalSourceLineage;
  remainingBudget?: number;
  terminationReason?: RetrievalTerminationReason;
};

export type ContextIntelligenceProvenanceTrace = {
  status: 'PASS' | 'PARTIAL' | 'FAIL';
  stages: readonly {
    stage:
      | 'REQUEST'
      | 'INFORMATION_NEED'
      | 'NORMALIZED_REQUEST'
      | 'RETRIEVAL_PLAN'
      | 'CAPABILITY'
      | 'TOOL_INPUT'
      | 'OBSERVATION'
      | 'EVIDENCE_EVALUATION'
      | 'CLASSIFICATION'
      | 'ADAPTATION'
      | 'GROUNDING'
      | 'DECISION';
    objectId: string;
    parentIds: readonly string[];
  }[];
};

export type ContextContract = {
  version: 1;
  requestId: string;
  scope: ContextScope;
  rawRequest: string;
  intent: NormalizedIntent;
  contextNeeds: readonly ContextNeed[];
  constraints: readonly string[];
  requiredEntities: readonly IntentEntity[];
  temporal?: TemporalRequirement;
  memories: readonly MemoryItem[];
  memoryAssessment: MemoryRecallAssessment;
  evidence: readonly EvidenceItem[];
  evidenceGroups: readonly EvidenceGroup[];
  crossDocument: CrossDocumentSynthesis;
  lifecycle: readonly ContextLifecycleEvent[];
  feedback?: readonly ContextFeedbackRecord[];
  predictiveContext?: PredictiveContextProjection;
  optimization?: RuntimeOptimizationSummary;
  evaluation?: ContextEvaluationSnapshot;
  sources: readonly SourceMetadata[];
  conflicts: readonly ContextConflict[];
  capabilities: readonly SelectedCapability[];
  toolPlan: ToolPlan;
  observations: readonly ToolObservation[];
  findings: readonly ContextItem[];
  taskState: TaskState;
  queryPlan: QueryPlan;
  retrieval: RetrievalOutcome;
  runtimeRetrieval: readonly RuntimeRetrievalOperation[];
  adaptiveRetrieval: AdaptiveRetrievalSummary;
  resources: readonly ResourceRecord[];
  reasoning: ReasoningSupport;
  budget: ContextBudgetSnapshot;
  provenance: readonly Provenance[];
  items: readonly ContextItem[];
  offloadedArtifacts: readonly OffloadedArtifact[];
  finalContext?: FinalizedContext;
  quality: ContextQualityReport;
  directive: ContextRuntimeDirective;
  /** Post-model claim grounding. NOT_EVALUATED until a terminal answer exists. */
  grounding: GroundingAssessment;
  pendingDecisions: readonly string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/**
 * Bounded application outcome for a turn that Context Intelligence ends before
 * model invocation. It contains decision metadata only, never request or evidence
 * content, and is safe to persist independently of the canonical transcript.
 */
export type ContextIntelligenceTerminalDecision = Extract<
  ContextQualityDecision,
  'CLARIFY' | 'CONFLICT' | 'DENY' | 'ABSTAIN'
>;

export type ContextIntelligenceIntervention = {
  kind: 'context-intelligence';
  decision: ContextIntelligenceTerminalDecision;
  terminal: true;
  continueToModel: false;
  reasonCodes: readonly string[];
  clarificationNeeds: readonly ContextNeedType[];
};

/**
 * Application view of a Context Contract. Aggregate fields remain bounded while
 * `trace`, per-attempt inputs/results, and grounding preserve authoritative runtime
 * proof for the local Agent Console. Consumers must treat these trace fields as
 * conversation data rather than content-free metrics.
 */
export type ContextIntelligenceReport = {
  version: 1;
  requestId: string;
  intent: {
    operation: NormalizedIntent['operation'];
    complexity: NormalizedIntent['complexity'];
    confidence: number;
    constraints: number;
    requiredEntities: number;
    ambiguities: number;
  };
  contextNeeds: {
    total: number;
    required: number;
    missing: number;
    unavailable: number;
    clarificationRequired: number;
    types: Readonly<Partial<Record<ContextNeedType, number>>>;
    capabilities: readonly ContextCapability[];
  };
  query: {
    variants: number;
    transformations: Readonly<Partial<Record<QueryVariant['kind'], number>>>;
  };
  retrieval: {
    providers: readonly string[];
    providerCount: number;
    iterations: number;
    results: number;
    sufficient: boolean;
    insufficiencies: number;
    conflicts: number;
    operations: number;
    operationOutcomes?: Readonly<Partial<Record<RuntimeRetrievalOperation['status'], number>>>;
    executionStates?: Readonly<Partial<Record<ExecutionState, number>>>;
    resourceStates?: Readonly<Partial<Record<ResourceState, number>>>;
    toolNames: readonly string[];
    attempts: readonly ContextIntelligenceAttemptTrace[];
    adaptive: {
      state: RetrievalState;
      attemptCount: number;
      remainingBudget: number;
      strategies: Readonly<Partial<Record<RetrievalAdaptationStrategy, number>>>;
      outcomes: Readonly<Partial<Record<RetrievalOutcomeClassification, number>>>;
      evidenceQuality: RetrievalEvidenceQuality;
      triggered: boolean;
      reason?: string;
      evidenceGap?: string;
      meaningfulStrategyChange?: boolean;
      terminationReason?: RetrievalTerminationReason;
    };
  };
  trace: {
    informationNeeds: readonly {
      needId: string;
      informationNeed: string;
      normalizedRequest: string;
      capability: ContextCapability;
    }[];
    provenance: ContextIntelligenceProvenanceTrace;
  };
  grounding: GroundingAssessment;
  memory: {
    recalled: number;
    types: Readonly<Partial<Record<MemoryType, number>>>;
    reconciliation?: {
      retained: number;
      ignored: number;
      stale: number;
      conflicts: number;
    };
  };
  lifecycle?: {
    events: number;
    states: Readonly<Partial<Record<ContextLifecycleState, number>>>;
  };
  capabilities: {
    available: number;
    selected: number;
    excluded: number;
    names: readonly string[];
  };
  observations: {
    total: number;
    outcomes: Readonly<Partial<Record<ToolOutcome, number>>>;
    facts: number;
    identifiers: number;
    followUps: number;
    offloaded: number;
  };
  task: {
    status: TaskState['status'];
    steps: number;
    completed: number;
    pending: number;
    retries: number;
    unresolvedIssues: number;
    pendingDecisions: number;
  };
  quality: {
    status: ContextQualityStatus;
    decision: ContextQualityDecision;
    score: number;
    sufficient: boolean;
    conflicts: number;
    issues: readonly {
      code: QualityIssueCode;
      severity: ContextQualityIssue['severity'];
      remediation: ContextQualityIssue['remediation'];
      items: number;
    }[];
  };
  budget: ContextBudgetSnapshot;
  finalContext: {
    items: number;
    canonicalItems?: number;
    activeItems?: number;
    evidence: number;
    sources: number;
    sections: number;
    tools: number;
    omittedItems: number;
    omittedMessages: number;
    offloadedArtifacts: number;
    provenanceRecords: number;
  };
  intervention: {
    required: boolean;
    continueToModel: boolean;
    decision: ContextQualityDecision;
    reasonCodes: readonly string[];
    clarificationNeeds: readonly ContextNeedType[];
  };
  reasoning: {
    mode: ReasoningSupport['mode'];
    alternatives: number;
    planSteps: number;
  };
  feedback?: {
    total: number;
    categories: Readonly<Partial<Record<ContextFeedbackCategory, number>>>;
    outcomes: Readonly<Partial<Record<ContextFeedbackOutcome, number>>>;
  };
  prediction?: {
    hints: number;
    satisfiedDependencies: number;
    evidenceReferences: number;
    truncated: boolean;
  };
  optimization?: RuntimeOptimizationSummary;
  evaluation?: ContextEvaluationSnapshot;
  updatedAt: ISODateTime;
};

export type RuntimeOperationSnapshot = Omit<
  RuntimeRetrievalOperation,
  | 'input'
  | 'actualInput'
  | 'actualResult'
  | 'resourceCandidates'
  | 'sourceLineage'
  | 'strategyChange'
>;

export type ContextLifecycleSnapshot = Omit<ContextLifecycleEvent, 'reason' | 'metadata'> & {
  reasonCode: string;
};

export type ContextSnapshot = {
  version: 1;
  requestId: string;
  taskId: string;
  decision: ContextQualityDecision;
  qualityStatus: ContextQualityStatus;
  activeItemIds: readonly string[];
  evidenceIds: readonly string[];
  offloadedArtifactIds: readonly string[];
  lifecycleEventIds: readonly string[];
  updatedAt: ISODateTime;
};

export type PersistedContextIntelligenceState = {
  version: 1;
  taskState?: TaskState;
  memories: readonly MemoryItem[];
  observations: readonly ToolObservation[];
  offloadedArtifacts: readonly OffloadedArtifact[];
  recentOperations?: readonly RuntimeOperationSnapshot[];
  lifecycleEvents?: readonly ContextLifecycleSnapshot[];
  feedback?: readonly ContextFeedbackRecord[];
  performanceProfiles?: readonly RuntimePerformanceProfile[];
  lastEvaluation?: ContextEvaluationSnapshot;
  lastSnapshot?: ContextSnapshot;
  /** Legacy v1 field read for migration only; new snapshots stay bounded. */
  lastContract?: ContextContract;
  updatedAt: ISODateTime;
};

/** Compatibility aliases for the shared P0-P3 vocabulary. */
export type ContextSource = SourceMetadata;
export type ContextCandidate = ContextItem;
export type RetrievalPlan = QueryPlan;
export type RetrievalObservation = ToolObservation;
export type ContextDecision = ContextQualityDecision;
export type ContextQuality = ContextQualityReport;
export type ConflictGroup = ContextConflict;
