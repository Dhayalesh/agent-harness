import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveRetrievalIntelligence,
  DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  RuntimeRetrievalPlanner,
  type AdaptiveRetrievalSummary,
  type CapabilityMetadata,
  type ContextConflict,
  type ContextNeed,
  type EvidenceItem,
  type NormalizedIntent,
  type RetrievalOutcomeClassification,
  type RuntimeRetrievalOperation,
  type SelectedCapability,
  type ToolObservation,
  type ToolPlan,
} from '../../src/index.js';
import { stableHash } from '../../src/context-intelligence/utils.js';

const timestamp = '2026-09-01T00:00:00.000Z';
const config = {
  ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  budgets: {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets,
    maxLoopMilliseconds: 60_000,
  },
};
const evaluator = new AdaptiveRetrievalIntelligence(config);

test('classifies every Priority 1 retrieval outcome without fabricating evidence', () => {
  const cases: Array<{
    name: string;
    expected: RetrievalOutcomeClassification;
    operation: RuntimeRetrievalOperation;
    observation?: ToolObservation;
    evidence?: EvidenceItem;
    conflict?: ContextConflict;
    needStatus?: ContextNeed['status'];
  }> = [
    { name: 'no result', expected: 'NO_RESULT', operation: operation({ status: 'succeeded' }) },
    {
      name: 'empty',
      expected: 'EMPTY_RESULT',
      operation: operation({ status: 'empty', executionState: 'EMPTY' }),
      observation: observation({ outcome: 'empty', content: '' }),
    },
    {
      name: 'low relevance',
      expected: 'LOW_RELEVANCE',
      operation: operation({ status: 'succeeded' }),
      observation: observation(),
      evidence: evidence({ admitted: false, reasons: ['relevance below admission threshold'] }),
    },
    {
      name: 'insufficient evidence',
      expected: 'INSUFFICIENT_EVIDENCE',
      operation: operation({ status: 'succeeded' }),
      observation: observation(),
      evidence: evidence(),
    },
    {
      name: 'stale',
      expected: 'STALE_EVIDENCE',
      operation: operation({ status: 'succeeded' }),
      observation: observation(),
      evidence: evidence({ admitted: false, reasons: ['source freshness below requirement'] }),
    },
    {
      name: 'source conflict',
      expected: 'SOURCE_CONFLICT',
      operation: operation({ status: 'succeeded' }),
      observation: observation(),
      evidence: evidence(),
      conflict: conflict(),
    },
    {
      name: 'tool failure',
      expected: 'TOOL_FAILURE',
      operation: operation({ status: 'failed', executionState: 'FAILED' }),
      observation: observation({ outcome: 'error' }),
    },
    {
      name: 'access failure',
      expected: 'ACCESS_FAILURE',
      operation: operation({
        status: 'denied',
        executionState: 'BLOCKED',
        failureClassification: 'authorization_denied',
      }),
      observation: observation({ outcome: 'denied' }),
    },
    {
      name: 'invalid reference',
      expected: 'INVALID_REFERENCE',
      operation: operation({
        status: 'failed',
        executionState: 'FAILED',
        failureClassification: 'not_found',
      }),
      observation: observation({ outcome: 'error' }),
    },
    {
      name: 'success',
      expected: 'RETRIEVAL_SUCCESS',
      operation: operation({ status: 'succeeded' }),
      observation: observation(),
      evidence: evidence(),
      needStatus: 'satisfied',
    },
  ];

  for (const scenario of cases) {
    const result = evaluator.evaluate({
      requestId: 'request-1',
      needs: [need(scenario.needStatus ?? 'missing')],
      operations: [scenario.operation],
      observations: scenario.observation ? [scenario.observation] : [],
      evaluatedEvidence: scenario.evidence ? [scenario.evidence] : [],
      conflicts: scenario.conflict ? [scenario.conflict] : [],
      elapsedMs: 1,
    });
    assert.equal(result.attempts[0]?.outcome, scenario.expected, scenario.name);
  }
});

test('maps failures to explicit adaptations and terminal decisions', () => {
  const empty = assessmentFor(
    operation({ status: 'empty', executionState: 'EMPTY' }),
    observation({ outcome: 'empty', content: '' }),
  );
  assert.deepEqual(empty.needs[0]?.recommendedStrategies.slice(0, 2), [
    'RETRIEVAL_BROADEN',
    'SOURCE_SWITCH',
  ]);

  const lowRelevance = assessmentFor(
    operation({ status: 'succeeded' }),
    observation(),
    evidence({ admitted: false, reasons: ['relevance below admission threshold'] }),
  );
  assert.equal(lowRelevance.needs[0]?.recommendedStrategies[0], 'RETRIEVAL_NARROW');

  // invalid_input without a query-like argument (e.g. a bad file path reference) → INVALID_REFERENCE
  const invalid = assessmentFor(
    operation({
      status: 'failed',
      executionState: 'FAILED',
      failureClassification: 'invalid_input',
      input: { path: '/nonexistent/bad-path.txt' },
    }),
    observation({ outcome: 'error' }),
  );
  assert.deepEqual(invalid.needs[0]?.recommendedStrategies, []);
  assert.equal(invalid.terminationReason, 'INVALID_REFERENCE');

  // invalid_input with a query-like argument (e.g. an oversized search query) → TOOL_FAILURE
  // Decomposition comes first because the query itself is the source of the invalidity.
  const invalidQuery = assessmentFor(
    operation({
      status: 'failed',
      executionState: 'FAILED',
      failureClassification: 'invalid_input',
      // Short query: not oversized → QUERY_REWRITE first; QUERY_DECOMPOSITION second
      input: { query: intent.normalizedRequest, maxResults: 5 },
    }),
    observation({ outcome: 'error' }),
  );
  assert.deepEqual(invalidQuery.needs[0]?.recommendedStrategies.slice(0, 2), [
    'QUERY_REWRITE',
    'QUERY_DECOMPOSITION',
  ]);

  const access = assessmentFor(
    operation({
      status: 'denied',
      executionState: 'BLOCKED',
      failureClassification: 'authorization_denied',
    }),
    observation({ outcome: 'denied' }),
  );
  assert.deepEqual(access.needs[0]?.recommendedStrategies, ['SOURCE_SWITCH']);
});

test('broadens an empty web search with a meaningfully changed bounded action', () => {
  const prior = operation({
    status: 'empty',
    executionState: 'EMPTY',
    input: { query: intent.normalizedRequest, maxResults: 5 },
  });
  const adaptive = assessmentFor(prior, observation({ outcome: 'empty', content: '' }));
  const actions = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need()],
    toolPlan: webToolPlan(['search-a']),
    observations: [observation({ outcome: 'empty', content: '' })],
    operations: [prior],
    adaptive,
    elapsedMs: 1,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.strategy, 'RETRIEVAL_BROADEN');
  assert.equal(actions[0]?.toolName, 'search-a');
  assert.equal(actions[0]?.input.maxResults, 10);
  assert.notEqual(actions[0]?.attemptKey, prior.attemptKey);
  assert.equal(actions[0]?.previousStrategy, 'INITIAL');
});

test('switches away from an inaccessible capability instead of repeating it', () => {
  const prior = operation({
    status: 'denied',
    executionState: 'BLOCKED',
    failureClassification: 'authorization_denied',
    input: { query: intent.normalizedRequest, maxResults: 5 },
  });
  const adaptive = assessmentFor(prior, observation({ outcome: 'denied' }));
  const actions = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need()],
    toolPlan: webToolPlan(['search-a', 'search-b']),
    observations: [observation({ outcome: 'denied' })],
    operations: [prior],
    adaptive,
    elapsedMs: 1,
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.strategy, 'SOURCE_SWITCH');
  assert.equal(actions[0]?.toolName, 'search-b');
});

test('preserves a satisfied-but-conflicting need and seeks complementary evidence', () => {
  const observed = observation({ links: ['https://example.test/second-source'] });
  const prior = operation({
    status: 'succeeded',
    actualInput: { query: intent.normalizedRequest, maxResults: 5 },
    invokedAt: timestamp,
    actualResult: {
      content: 'Search result containing https://example.test/second-source',
      metadata: { url: 'https://example.test/second-source' },
    },
    resultReceivedAt: timestamp,
  });
  const adaptive = evaluator.evaluate({
    requestId: 'request-1',
    needs: [need('satisfied')],
    operations: [prior],
    observations: [observed],
    evaluatedEvidence: [evidence()],
    conflicts: [conflict()],
    elapsedMs: 1,
  });

  assert.equal(adaptive.needs[0]?.outcome, 'SOURCE_CONFLICT');
  assert.equal(adaptive.needs[0]?.recommendedStrategies[0], 'ADDITIONAL_EVIDENCE');
  assert.equal(adaptive.terminationReason, undefined);

  const actions = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need('satisfied')],
    toolPlan: webToolPlan(['search-a']),
    observations: [observed],
    operations: [prior],
    adaptive,
    elapsedMs: 1,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.strategy, 'ADDITIONAL_EVIDENCE');
  assert.equal(actions[0]?.capability, 'WEB_FETCH');
  assert.equal(actions[0]?.input.url, 'https://example.test/second-source');
});

test('permits only one observable identical retry for a transient failure', () => {
  const prior = operation({
    status: 'failed',
    executionState: 'FAILED',
    failureClassification: 'timeout',
    input: { query: intent.normalizedRequest, maxResults: 5 },
  });
  const firstAssessment = assessmentFor(prior, observation({ outcome: 'error' }));
  const first = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need()],
    toolPlan: webToolPlan(['search-a']),
    observations: [observation({ outcome: 'error' })],
    operations: [prior],
    adaptive: firstAssessment,
    elapsedMs: 1,
  });

  assert.equal(first[0]?.strategy, 'TRANSIENT_RETRY');
  assert.equal(first[0]?.attemptKey, prior.attemptKey);

  const retry = operation({
    id: 'operation-2',
    iteration: 2,
    strategy: 'TRANSIENT_RETRY',
    status: 'failed',
    executionState: 'FAILED',
    failureClassification: 'timeout',
    input: prior.input,
  });
  const secondAssessment = evaluator.evaluate({
    requestId: 'request-1',
    needs: [need()],
    operations: [prior, retry],
    observations: [
      observation({ id: 'observation-1', outcome: 'error' }),
      observation({ id: 'observation-2', toolCallId: 'operation-2', outcome: 'error' }),
    ],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 1,
  });
  const second = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need()],
    toolPlan: webToolPlan(['search-a']),
    observations: [],
    operations: [prior, retry],
    adaptive: secondAssessment,
    elapsedMs: 1,
  });
  assert.deepEqual(second, []);
});

test('terminates explicitly when the configured retrieval iteration budget is exhausted', () => {
  const exhaustedOperation = operation({
    iteration: config.budgets.maxRetrievalIterations,
    status: 'empty',
    executionState: 'EMPTY',
  });
  const adaptive = assessmentFor(
    exhaustedOperation,
    observation({ outcome: 'empty', content: '' }),
  );

  assert.equal(adaptive.state, 'EXHAUSTED');
  assert.equal(adaptive.remainingRetrievalBudget, 0);
  assert.equal(adaptive.terminationReason, 'RETRIEVAL_BUDGET_EXHAUSTED');
  assert.deepEqual(
    planner().plan({
      requestId: 'request-1',
      intent,
      needs: [need()],
      toolPlan: webToolPlan(['search-a', 'search-b']),
      observations: [],
      operations: [exhaustedOperation],
      adaptive,
      elapsedMs: 1,
    }),
    [],
  );
});

function assessmentFor(
  runtimeOperation: RuntimeRetrievalOperation,
  runtimeObservation: ToolObservation,
  evaluatedEvidence?: EvidenceItem,
): AdaptiveRetrievalSummary {
  return evaluator.evaluate({
    requestId: 'request-1',
    needs: [need()],
    operations: [runtimeOperation],
    observations: [runtimeObservation],
    evaluatedEvidence: evaluatedEvidence ? [evaluatedEvidence] : [],
    conflicts: [],
    elapsedMs: 1,
  });
}

function planner(): RuntimeRetrievalPlanner {
  return new RuntimeRetrievalPlanner(config);
}

function need(status: ContextNeed['status'] = 'missing'): ContextNeed {
  return {
    id: 'need-1',
    type: 'CURRENT_EXTERNAL_INFORMATION',
    required: true,
    requiredInformation: ['current evidence'],
    missingInformation: status === 'satisfied' ? [] : ['current evidence'],
    reason: 'Current evidence is required.',
    sourceRequirement: 'external',
    sourceKinds: ['WEB'],
    freshnessRequirement: 'CURRENT',
    authorityRequirement: 'ANY',
    scope: {
      conversationId: 'conversation-1',
      taskId: 'task-1',
      namespaces: ['test'],
    },
    evidenceRequirement: 'REQUIRED',
    requiredCapability: 'WEB_RETRIEVAL',
    capabilityRequirement: {
      id: 'requirement-1',
      needId: 'need-1',
      capability: 'WEB_RETRIEVAL',
      prerequisiteCapabilities: ['WEB_SEARCH'],
      alternativeCapabilities: ['WEB_FETCH'],
      sourceKinds: ['WEB'],
      readOnly: true,
      requiredInputs: ['query'],
      authorityRequirement: 'ANY',
      freshnessRequirement: 'CURRENT',
    },
    priority: 'high',
    status,
    inputs: { query: intent.normalizedRequest },
    normalizedRetrievalRequest: {
      informationNeed: intent.normalizedRequest,
      request: intent.normalizedRequest,
    },
  };
}

const intent: NormalizedIntent = {
  originalRequest: 'Find the current release status for Project Aurora.',
  normalizedRequest: 'current release status Project Aurora',
  goal: 'Find the current release status for Project Aurora.',
  operation: 'answer',
  entities: [{ name: 'Project Aurora', value: 'Project Aurora', required: true, confidence: 1 }],
  constraints: [],
  temporal: { expression: 'current', requiresCurrentData: true },
  ambiguity: [],
  keywords: ['current', 'release', 'status', 'project', 'aurora'],
  complexity: 'simple',
  confidence: 1,
  instructionSegments: {
    userIntent: 'Find the current release status for Project Aurora.',
    taskInstructions: [],
    retrievalInstructions: [],
    systemToolInstructions: [],
    formattingInstructions: [],
    informationRequirements: ['current release status Project Aurora'],
  },
};

function resolution() {
  return {
    needId: 'need-1',
    requested: 'WEB_RETRIEVAL' as const,
    requiredCapabilities: ['WEB_SEARCH', 'WEB_FETCH'] as const,
    permittedCapabilities: ['WEB_SEARCH', 'WEB_FETCH'] as const,
    status: 'available' as const,
    toolNames: ['search-a', 'search-b', 'fetch-a'],
    alternatives: { WEB_SEARCH: ['search-a', 'search-b'], WEB_FETCH: ['fetch-a'] },
    reason: 'Compatible tools are registered.',
  };
}

function operation(partial: Partial<RuntimeRetrievalOperation> = {}): RuntimeRetrievalOperation {
  const input = partial.input ?? { query: intent.normalizedRequest, maxResults: 5 };
  return {
    id: partial.id ?? 'operation-1',
    retrievalPlanId: partial.retrievalPlanId ?? 'retrieval-plan-1',
    requestId: 'request-1',
    needId: 'need-1',
    capability: 'WEB_SEARCH',
    phase: 'discovery',
    toolName: 'search-a',
    input,
    attemptKey: partial.attemptKey ?? stableHash({ toolName: 'search-a', input }),
    strategy: 'INITIAL',
    priorOperationIds: partial.priorOperationIds ?? [],
    iteration: 1,
    status: 'succeeded',
    executionState: 'SUCCESS',
    resourceState: 'RETRIEVED_SUCCESSFULLY',
    observationId: partial.observationId ?? 'observation-1',
    startedAt: timestamp,
    completedAt: timestamp,
    ...partial,
  };
}

function observation(partial: Partial<ToolObservation> = {}): ToolObservation {
  const source = {
    id: 'source-1',
    name: 'Search source',
    type: 'external' as const,
    sourceKind: 'WEB' as const,
    authority: 0.7,
    retrievedAt: timestamp,
    uri: 'https://example.test/result',
  };
  return {
    id: 'observation-1',
    toolCallId: 'operation-1',
    toolName: 'search-a',
    outcome: 'success',
    content: 'Project Aurora release status is current.',
    facts: ['Project Aurora release status is current.'],
    identifiers: [],
    errors: [],
    source,
    provenance: {
      id: 'provenance-1',
      source,
      steps: [
        {
          operation: 'retrieved',
          at: timestamp,
          component: 'test',
          inputIds: ['operation-1'],
        },
      ],
      parentIds: [],
    },
    requiresFollowUp: false,
    createdAt: timestamp,
    requestId: 'request-1',
    needIds: ['need-1'],
    capability: 'WEB_SEARCH',
    ...partial,
  };
}

function evidence(evaluation: Partial<EvidenceItem['evaluation']> = {}): EvidenceItem {
  const observed = observation();
  const admitted = evaluation.admitted ?? true;
  return {
    id: 'evidence-1',
    kind: 'evidence',
    content: observed.content,
    source: observed.source,
    provenance: observed.provenance,
    lifecycleState: 'evaluated',
    relevance: 0.8,
    confidence: 0.9,
    authority: 0.7,
    freshness: 0.9,
    priority: 'high',
    tokenEstimate: 20,
    createdAt: timestamp,
    active: admitted,
    claims: observed.facts,
    claimKeys: ['project-aurora-status'],
    rank: 1,
    capability: 'WEB_SEARCH',
    observationId: 'observation-1',
    evidenceIdentity: 'source-1:status',
    relationship: 'supports',
    evaluation: {
      relevance: 0.8,
      authority: 0.7,
      freshness: 0.9,
      confidence: 0.9,
      provenanceComplete: true,
      admitted,
      reasons: [],
      ...evaluation,
    },
  };
}

function conflict(): ContextConflict {
  return {
    id: 'conflict-1',
    claimKey: 'project-aurora-status',
    itemIds: ['evidence-1', 'evidence-2'],
    reason: 'value',
    resolution: 'unresolved',
    resolutionStatus: 'requires_clarification',
    claims: [
      {
        itemId: 'evidence-1',
        value: 'current',
        sourceId: 'source-1',
        authority: 0.7,
      },
      {
        itemId: 'evidence-2',
        value: 'delayed',
        sourceId: 'source-2',
        authority: 0.7,
      },
    ],
    explanation: 'Sources disagree.',
  };
}

function webToolPlan(searchNames: readonly string[]): ToolPlan {
  const selected = [
    ...searchNames.map((name) => selectedCapability(name, 'WEB_SEARCH')),
    selectedCapability('fetch-a', 'WEB_FETCH'),
  ];
  return {
    goal: intent.goal,
    selected,
    excluded: [],
    argumentRequirements: Object.fromEntries(
      selected.map((entry) => [entry.capability.name, ['query']]),
    ),
    requirements: [need().capabilityRequirement],
    resolutions: [resolution()],
  };
}

function selectedCapability(
  name: string,
  capability: 'WEB_SEARCH' | 'WEB_FETCH',
): SelectedCapability {
  const metadata: CapabilityMetadata = {
    id: `tool:${name}`,
    name,
    description: capability === 'WEB_SEARCH' ? 'Search external sources' : 'Fetch an external URL',
    kind: 'network',
    keywords: ['search', 'fetch', 'web'],
    entityTypes: [],
    operations: [capability === 'WEB_SEARCH' ? 'search' : 'fetch'],
    sourceIds: [],
    sourceKinds: ['WEB'],
    authority: 0.7,
    cost: 0.2,
    latency: 0.2,
    preconditions: [],
    effects: ['reads data'],
    limitations: [],
    policyLabels: [],
    enabled: true,
    provides: [capability],
  };
  return {
    capability: metadata,
    score: 1,
    reasons: ['test'],
    descriptor: {
      name,
      description: metadata.description,
      inputSchema:
        capability === 'WEB_SEARCH'
          ? {
              type: 'object',
              properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
              required: ['query'],
            }
          : {
              type: 'object',
              properties: { url: { type: 'string' }, query: { type: 'string' } },
              required: ['url'],
            },
    },
  };
}

test('stops after one sufficient attempt without false adaptation', () => {
  const successfulOperation = operation({ status: 'succeeded', executionState: 'SUCCESS' });
  const successfulObservation = observation({ requiresFollowUp: false });
  const summary = evaluator.evaluate({
    requestId: 'request-1',
    needs: [need('satisfied')],
    operations: [successfulOperation],
    observations: [successfulObservation],
    evaluatedEvidence: [evidence()],
    conflicts: [],
    elapsedMs: 1,
    planningComplete: true,
  });

  assert.equal(summary.attemptCount, 1);
  assert.equal(summary.attempts[0]?.outcome, 'RETRIEVAL_SUCCESS');
  assert.equal(summary.attempts[0]?.adaptationReason, undefined);
  assert.equal(summary.attempts[0]?.nextStrategy, undefined);
  assert.deepEqual(summary.needs[0]?.recommendedStrategies, []);
  assert.equal(summary.terminationReason, 'SUFFICIENT_EVIDENCE');

  const actions = planner().plan({
    requestId: 'request-1',
    intent,
    needs: [need('satisfied')],
    toolPlan: webToolPlan(['search-a']),
    observations: [successfulObservation],
    operations: [successfulOperation],
    adaptive: summary,
    elapsedMs: 1,
  });
  assert.deepEqual(actions, []);
});
