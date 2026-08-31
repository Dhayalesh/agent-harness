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

export type NormalizedIntent = {
  originalRequest: string;
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
};

/** Generic information/capability vocabulary owned by Context Intelligence. */
export type ContextNeedType =
  'CURRENT_EXTERNAL_INFORMATION' | 'FILE_INFORMATION' | 'DOCUMENT_CREATION';

export type ContextCapability =
  | 'WEB_RETRIEVAL'
  | 'WEB_SEARCH'
  | 'WEB_FETCH'
  | 'FILE_READ'
  | 'MARKDOWN_ARTIFACT_CREATE'
  | 'DOCUMENT_ARTIFACT_CREATE';

export type ContextNeedStatus = 'satisfied' | 'missing' | 'unavailable' | 'clarification_required';

export type ContextNeed = {
  id: string;
  type: ContextNeedType;
  required: boolean;
  requiredInformation: readonly string[];
  missingInformation: readonly string[];
  reason: string;
  sourceRequirement: 'external' | 'workspace' | 'any';
  freshnessRequirement: 'CURRENT' | 'RECENT' | 'ANY';
  authorityRequirement: 'AUTHORITATIVE' | 'TRUSTED' | 'ANY';
  scope: ContextScope;
  evidenceRequirement: 'REQUIRED' | 'SUPPORTING' | 'NONE';
  requiredCapability: ContextCapability;
  priority: 'critical' | 'high' | 'normal' | 'low';
  status: ContextNeedStatus;
  /** Validated arguments known before capability execution, such as a file path. */
  inputs: Readonly<Record<string, unknown>>;
};

export type SourceType =
  | 'user'
  | 'conversation'
  | 'memory'
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
  provider?: string;
  authority: number;
  retrievedAt?: ISODateTime;
  observedAt?: ISODateTime;
  validFrom?: ISODateTime;
  validUntil?: ISODateTime;
  version?: string;
  scope?: readonly string[];
  uri?: string;
  contentHash?: string;
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

export type ContextItem = {
  id: string;
  kind: ContextItemKind;
  title?: string;
  content: string;
  structured?: unknown;
  source: SourceMetadata;
  provenance: Provenance;
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

export type EvidenceItem = ContextItem & {
  kind: 'evidence';
  claims: readonly string[];
  retrievalQuery?: string;
  rank: number;
  capability?: ContextCapability;
  observationId?: string;
};

export type ContextConflict = {
  id: string;
  claimKey: string;
  itemIds: readonly string[];
  reason: 'value' | 'scope' | 'time' | 'version' | 'authority';
  resolution: 'authority' | 'freshness' | 'scope' | 'unresolved';
  preferredItemId?: string;
  explanation: string;
};

export type TaskStep = {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  dependencies: readonly string[];
  attempts: number;
  evidenceIds: readonly string[];
  receiptIds: readonly string[];
  updatedAt: ISODateTime;
};

export type TaskState = {
  taskId: string;
  goal: string;
  scope: readonly string[];
  plan: readonly TaskStep[];
  completedSteps: readonly string[];
  pendingSteps: readonly string[];
  constraints: readonly string[];
  confirmations: readonly string[];
  retries: number;
  receipts: readonly string[];
  unresolvedIssues: readonly string[];
  pendingDecisions: readonly string[];
  variables: Readonly<Record<string, unknown>>;
  status: 'active' | 'completed' | 'blocked' | 'failed';
  updatedAt: ISODateTime;
};

export type MemoryType = 'short-term' | 'working' | 'semantic' | 'procedural' | 'episodic';
export type MemoryLifecycleStatus = 'active' | 'superseded' | 'expired' | 'deleted';

export type MemoryItem = {
  id: string;
  type: MemoryType;
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
};

export type CapabilityResolution = {
  needId: string;
  requested: ContextCapability;
  requiredCapabilities: readonly ContextCapability[];
  status: 'available' | 'unavailable';
  toolNames: readonly string[];
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
  resolutions: readonly CapabilityResolution[];
};

export type ContextRuntimeAction = {
  id: string;
  requestId: string;
  needId: string;
  capability: Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  reason: string;
  iteration: number;
};

export type RuntimeRetrievalOperation = {
  id: string;
  requestId: string;
  needId: string;
  capability: Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  iteration: number;
  status: 'planned' | 'succeeded' | 'empty' | 'failed' | 'denied';
  observationId?: string;
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
  createdAt: ISODateTime;
  requestId?: string;
  needIds?: readonly string[];
  capability?: Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
  links?: readonly string[];
};

export type OffloadedArtifact = {
  id: string;
  artifactId: string;
  kind: 'tool-result' | 'document' | 'observation' | 'intermediate' | 'history';
  summary: string;
  size: number;
  contentType: string;
  provenance: Provenance;
  createdAt: ISODateTime;
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
  'ACCEPT' | 'RETRIEVE' | 'CLARIFY' | 'CONFLICT' | 'DENY' | 'ABSTAIN';

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
  evidence: readonly EvidenceItem[];
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
  reasoning: ReasoningSupport;
  budget: ContextBudgetSnapshot;
  provenance: readonly Provenance[];
  items: readonly ContextItem[];
  offloadedArtifacts: readonly OffloadedArtifact[];
  finalContext?: FinalizedContext;
  quality: ContextQualityReport;
  directive: ContextRuntimeDirective;
  pendingDecisions: readonly string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/**
 * Bounded, content-free view of a Context Contract for application consumers.
 *
 * The full contract can contain user text, retrieved evidence, memory, and tool
 * observations. Shipping it on every event would duplicate model context over the
 * wire and turn ordinary run telemetry into another content store. This report keeps
 * the decisions an application needs to explain and monitor the layer: counts,
 * statuses, bounded capability/provider names, and the exact budget allocation.
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
    toolNames: readonly string[];
  };
  memory: {
    recalled: number;
    types: Readonly<Partial<Record<MemoryType, number>>>;
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
  updatedAt: ISODateTime;
};

export type PersistedContextIntelligenceState = {
  version: 1;
  taskState?: TaskState;
  memories: readonly MemoryItem[];
  observations: readonly ToolObservation[];
  offloadedArtifacts: readonly OffloadedArtifact[];
  lastContract?: ContextContract;
  updatedAt: ISODateTime;
};
