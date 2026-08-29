import type { AgentMessage } from '../core/messages.js';
import type {
  ContextItem,
  ContextScope,
  EvidenceItem,
  MemoryItem,
  NormalizedIntent,
  QueryPlan,
  RetrievalOutcome,
  TaskState,
  ToolObservation,
  ToolPlan,
} from './contracts.js';
import {
  clamp,
  estimateTokens,
  freshnessScore,
  id,
  now,
  provenance,
  sourceMetadata,
} from './utils.js';

export class MultiSourceSynthesizer {
  synthesize(input: {
    request: string;
    intent: NormalizedIntent;
    scope: ContextScope;
    messages: readonly AgentMessage[];
    memories: readonly MemoryItem[];
    retrieval: RetrievalOutcome;
    observations: readonly ToolObservation[];
    taskState: TaskState;
    queryPlan: QueryPlan;
    toolPlan: ToolPlan;
    examples?: readonly { input: string; output: string }[];
  }): { items: readonly ContextItem[]; evidence: readonly EvidenceItem[] } {
    const createdAt = now();
    const userSource = sourceMetadata({
      id: `user:${input.scope.userId ?? 'current'}`,
      name: 'Current user request',
      type: 'user',
      authority: 1,
      observedAt: createdAt,
      scope: input.scope.namespaces,
    });
    const requestItem = contextItem({
      kind: 'request',
      title: 'User request',
      content: input.request,
      source: userSource,
      relevance: 1,
      confidence: 1,
      authority: 1,
      freshness: 1,
      priority: 'essential',
      claimKeys: input.intent.entities.map((entity) => entity.value),
    });
    const constraints = input.intent.constraints.map((constraint) =>
      contextItem({
        kind: 'constraint',
        title: 'Constraints',
        content: constraint,
        source: userSource,
        relevance: 1,
        confidence: 1,
        authority: 1,
        freshness: 1,
        priority: 'essential',
      }),
    );
    const responseRequirement = input.intent.requestedOutput
      ? contextItem({
          kind: 'instruction',
          title: 'Response requirements',
          content: `Produce the requested output as ${input.intent.requestedOutput}. Preserve evidence references and unresolved uncertainty.`,
          source: userSource,
          relevance: 1,
          confidence: 1,
          authority: 1,
          freshness: 1,
          priority: 'essential',
        })
      : undefined;
    const taskSource = sourceMetadata({
      id: `task:${input.taskState.taskId}`,
      name: 'Canonical task state',
      type: 'derived',
      authority: 0.9,
      observedAt: input.taskState.updatedAt,
    });
    const taskItem = contextItem({
      kind: 'task-state',
      title: 'Task state',
      content: renderTaskState(input.taskState),
      structured: input.taskState,
      source: taskSource,
      relevance: 0.95,
      confidence: 0.95,
      authority: 0.9,
      freshness: 1,
      priority: 'high',
    });
    const memoryItems = input.memories.map((memory) =>
      contextItem({
        kind: 'memory',
        title: `${memory.type} memory`,
        content: memory.content,
        structured: memory.structured,
        source: memory.provenance.source,
        relevance: memory.relevance,
        confidence: memory.confidence,
        authority: memory.authority,
        freshness: freshnessScore(memory.updatedAt, 90 * 24 * 60 * 60 * 1_000),
        priority: memory.type === 'procedural' ? 'high' : 'normal',
        claimKeys: memory.entities,
        ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
        provenanceValue: memory.provenance,
      }),
    );
    const evidence = input.retrieval.results.map<EvidenceItem>((result, index) => {
      const base = contextItem({
        kind: 'evidence',
        title: `Evidence from ${result.source.name}`,
        content: result.content,
        structured: result.structured,
        source: result.source,
        relevance: result.relevance,
        confidence: result.confidence,
        authority: result.authority,
        freshness: result.freshness,
        priority: result.authority >= 0.8 && result.relevance >= 0.6 ? 'high' : 'normal',
        claimKeys: result.claimKeys,
        provenanceValue: result.provenance,
      });
      return {
        ...base,
        kind: 'evidence',
        claims: result.claims,
        ...(input.queryPlan.variants.find((query) => query.id === result.queryId)?.query ===
        undefined
          ? {}
          : {
              retrievalQuery: input.queryPlan.variants.find(
                (query) => query.id === result.queryId,
              )!.query,
            }),
        rank: index + 1,
      };
    });
    const observations = input.observations.slice(-12).map((observation) =>
      contextItem({
        kind: 'observation',
        title: `Observation from ${observation.toolName}`,
        content: observation.content,
        structured: observation.structured,
        source: observation.source,
        relevance: observation.requiresFollowUp ? 0.65 : 0.85,
        confidence: observation.outcome === 'success' ? 0.9 : 0.55,
        authority: observation.source.authority,
        freshness: 1,
        priority: observation.outcome === 'error' ? 'high' : 'normal',
        claimKeys: observation.identifiers,
        provenanceValue: observation.provenance,
      }),
    );
    const planningSource = sourceMetadata({
      id: `plan:${input.queryPlan.id}`,
      name: 'Context Intelligence planner',
      type: 'derived',
      authority: 0.75,
      observedAt: createdAt,
    });
    const planItem = contextItem({
      kind: 'finding',
      title: 'Query and capability plan',
      content: renderPlans(input.queryPlan, input.toolPlan, input.retrieval),
      source: planningSource,
      relevance: 0.8,
      confidence: input.intent.confidence,
      authority: 0.75,
      freshness: 1,
      priority: 'normal',
    });
    const exampleItems = (input.examples ?? []).map((example) =>
      contextItem({
        kind: 'example',
        title: 'Contextual example',
        content: `Input: ${example.input}\nOutput: ${example.output}`,
        source: planningSource,
        relevance: 0.65,
        confidence: 0.9,
        authority: 0.75,
        freshness: 1,
        priority: 'low',
      }),
    );
    const history = recentHistoryItem(input.messages, input.intent, input.scope, createdAt);
    return {
      items: [
        requestItem,
        ...constraints,
        ...(responseRequirement ? [responseRequirement] : []),
        taskItem,
        ...memoryItems,
        ...evidence,
        ...observations,
        planItem,
        ...exampleItems,
        ...(history ? [history] : []),
      ],
      evidence,
    };
  }
}

function contextItem(input: {
  kind: ContextItem['kind'];
  title?: string;
  content: string;
  structured?: unknown;
  source: ContextItem['source'];
  relevance: number;
  confidence: number;
  authority: number;
  freshness: number;
  priority: ContextItem['priority'];
  claimKeys?: readonly string[];
  expiresAt?: string;
  provenanceValue?: ContextItem['provenance'];
}): ContextItem {
  const createdAt = now();
  return {
    id: id('context'),
    kind: input.kind,
    ...(input.title === undefined ? {} : { title: input.title }),
    content: input.content,
    ...(input.structured === undefined ? {} : { structured: input.structured }),
    source: input.source,
    provenance:
      input.provenanceValue ?? provenance(input.source, 'received', 'multi-source-synthesizer'),
    relevance: clamp(input.relevance),
    confidence: clamp(input.confidence),
    authority: clamp(input.authority),
    freshness: clamp(input.freshness),
    priority: input.priority,
    tokenEstimate: estimateTokens(input.content),
    createdAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.claimKeys === undefined ? {} : { claimKeys: input.claimKeys }),
    ...(input.source.policyLabels === undefined
      ? {}
      : { policyLabels: input.source.policyLabels }),
    active: true,
  };
}

function renderTaskState(state: TaskState): string {
  return [
    `Goal: ${state.goal}`,
    `Status: ${state.status}`,
    ...(state.constraints.length ? [`Constraints: ${state.constraints.join('; ')}`] : []),
    ...(state.plan.length
      ? [
          'Plan:',
          ...state.plan.map((step) => `- [${step.status}] ${step.description} (attempts: ${step.attempts})`),
        ]
      : []),
    ...(state.pendingDecisions.length
      ? [`Pending decisions: ${state.pendingDecisions.join('; ')}`]
      : []),
    ...(state.unresolvedIssues.length
      ? [`Unresolved issues: ${state.unresolvedIssues.join('; ')}`]
      : []),
  ].join('\n');
}

function renderPlans(plan: QueryPlan, tools: ToolPlan, retrieval: RetrievalOutcome): string {
  return [
    `Normalized query: ${plan.normalizedQuery}`,
    ...(plan.variants.length > 1
      ? [`Query variants: ${plan.variants.map((query) => `${query.kind}:${query.query}`).join(' | ')}`]
      : []),
    `Selected capabilities: ${
      tools.selected
        .map((entry) => {
          const required = tools.argumentRequirements[entry.capability.name] ?? [];
          const preconditions = entry.capability.preconditions;
          return `${entry.capability.name}${
            required.length ? ` (required arguments: ${required.join(', ')})` : ''
          }${preconditions.length ? ` [preconditions: ${preconditions.join('; ')}]` : ''}`;
        })
        .join(', ') || 'none'
    }`,
    `Retrieval: ${retrieval.sufficient ? 'sufficient' : 'insufficient'} (${retrieval.results.length} accepted results)`,
    ...(retrieval.insufficiencies.length
      ? [`Retrieval gaps: ${retrieval.insufficiencies.join('; ')}`]
      : []),
  ].join('\n');
}

function recentHistoryItem(
  messages: readonly AgentMessage[],
  intent: NormalizedIntent,
  scope: ContextScope,
  createdAt: string,
): ContextItem | undefined {
  const selected = messages
    .slice(-6)
    .map((message) => {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return text ? `${message.role}: ${text.slice(0, 1_500)}` : '';
    })
    .filter(Boolean);
  if (selected.length === 0) return undefined;
  const source = sourceMetadata({
    id: `conversation:${scope.conversationId}`,
    name: 'Recent relevant conversation',
    type: 'conversation',
    authority: 0.8,
    observedAt: createdAt,
  });
  return contextItem({
    kind: 'history',
    title: 'Relevant history',
    content: selected.join('\n'),
    source,
    relevance: intent.complexity === 'simple' ? 0.45 : 0.7,
    confidence: 0.9,
    authority: 0.8,
    freshness: 0.9,
    priority: 'low',
  });
}
