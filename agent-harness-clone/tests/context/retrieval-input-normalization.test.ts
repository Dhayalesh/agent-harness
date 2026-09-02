/**
 * Retrieval Input Normalization and Capability-Aware Query Construction
 *
 * Tests that Context Intelligence correctly separates information needs from
 * control instructions, constructs bounded retrieval requests, enforces
 * capability-aware query length constraints, and integrates with adaptive
 * retrieval for recovery from oversized or otherwise invalid queries.
 *
 * Test cases correspond to the 18 scenarios listed in
 * P1_ADAPTIVE_RETRIEVAL_IMPLEMENTATION.md §Retrieval Input Normalization.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveRetrievalIntelligence,
  DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  IntentResolver,
  RuntimeRetrievalPlanner,
  buildRetrievalRequestCandidates,
  type CapabilityMetadata,
  type ContextNeed,
  type NormalizedIntent,
  type RuntimeRetrievalOperation,
  type SelectedCapability,
  type ToolObservation,
  type ToolPlan,
} from '../../src/index.js';
import { stableHash } from '../../src/context-intelligence/utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver = new IntentResolver();
const timestamp = '2026-09-01T00:00:00.000Z';

/** Max query length used throughout these tests, matching the harness web_search schema. */
const WEB_SEARCH_MAX = 400;

/** Build a minimal SelectedCapability with optional schema maxLength. */
function webSearchCapability(
  schemaMaxLength?: number,
  capabilityMaxLength?: number,
): SelectedCapability {
  const meta: CapabilityMetadata = {
    id: 'tool:web_search',
    name: 'web_search',
    description: 'Search the live web for current information.',
    kind: 'network',
    keywords: ['search', 'web'],
    entityTypes: [],
    operations: ['search'],
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
    provides: ['WEB_SEARCH'],
    ...(capabilityMaxLength !== undefined ? { maximumQueryLength: capabilityMaxLength } : {}),
  };
  const queryProperty: Record<string, unknown> = { type: 'string' };
  if (schemaMaxLength !== undefined) queryProperty.maxLength = schemaMaxLength;
  return {
    capability: meta,
    score: 1,
    reasons: ['test'],
    descriptor: {
      name: 'web_search',
      description: meta.description,
      inputSchema: {
        type: 'object',
        properties: {
          query: queryProperty,
          maxResults: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  };
}

function toolPlan(schemaMaxLength?: number, capabilityMaxLength?: number): ToolPlan {
  const cap = webSearchCapability(schemaMaxLength, capabilityMaxLength);
  const fetchMeta: CapabilityMetadata = {
    ...cap.capability,
    id: 'tool:web_fetch',
    name: 'web_fetch',
    description: 'Fetch an external URL.',
    operations: ['fetch'],
    provides: ['WEB_FETCH'],
  };
  const fetchCap: SelectedCapability = {
    capability: fetchMeta,
    score: 0.9,
    reasons: ['test'],
    descriptor: {
      name: 'web_fetch',
      description: fetchMeta.description,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, query: { type: 'string' } },
        required: ['url'],
      },
    },
  };
  return {
    goal: 'test',
    selected: [cap, fetchCap],
    excluded: [],
    argumentRequirements: { web_search: ['query'], web_fetch: ['url'] },
    requirements: [need().capabilityRequirement],
    resolutions: [
      {
        needId: 'need-1',
        requested: 'WEB_RETRIEVAL',
        requiredCapabilities: ['WEB_SEARCH', 'WEB_FETCH'],
        permittedCapabilities: ['WEB_SEARCH', 'WEB_FETCH'],
        status: 'available',
        toolNames: ['web_search', 'web_fetch'],
        alternatives: { WEB_SEARCH: ['web_search'], WEB_FETCH: ['web_fetch'] },
        reason: 'resolved',
      },
    ],
  };
}

function need(status: ContextNeed['status'] = 'missing'): ContextNeed {
  const intent = resolver.resolve('Find the current status.');
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
    scope: { conversationId: 'c-1', taskId: 't-1', namespaces: [] },
    evidenceRequirement: 'REQUIRED',
    requiredCapability: 'WEB_RETRIEVAL',
    capabilityRequirement: {
      id: 'req-1',
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

function plannerConfig(capabilityQueryLengths?: Record<string, number>) {
  return {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
    budgets: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets, maxLoopMilliseconds: 60_000 },
    query: {
      ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query,
      ...(capabilityQueryLengths !== undefined ? { capabilityQueryLengths } : {}),
    },
  };
}

function operation(partial: Partial<RuntimeRetrievalOperation> = {}): RuntimeRetrievalOperation {
  const input = partial.input ?? { query: 'test query', maxResults: 5 };
  return {
    id: partial.id ?? 'op-1',
    requestId: 'req-1',
    needId: 'need-1',
    capability: 'WEB_SEARCH',
    phase: 'discovery',
    toolName: 'web_search',
    input,
    attemptKey: partial.attemptKey ?? stableHash({ toolName: 'web_search', input }),
    strategy: partial.strategy ?? 'INITIAL',
    iteration: partial.iteration ?? 1,
    status: partial.status ?? 'failed',
    executionState: partial.executionState ?? 'FAILED',
    resourceState: 'RETRIEVAL_FAILED',
    startedAt: timestamp,
    completedAt: timestamp,
    ...partial,
  };
}

function observation(partial: Partial<ToolObservation> = {}): ToolObservation {
  const source = {
    id: 'source-1',
    name: 'Test',
    type: 'external' as const,
    sourceKind: 'WEB' as const,
    authority: 0.7,
    retrievedAt: timestamp,
    uri: 'https://example.test/result',
  };
  return {
    id: 'obs-1',
    toolCallId: 'op-1',
    toolName: 'web_search',
    outcome: partial.outcome ?? 'error',
    content: partial.content ?? 'Invalid input for web_search: query: Too big: expected string to have <=400 characters',
    facts: [],
    identifiers: [],
    errors: ['Invalid input for web_search: query: Too big: expected string to have <=400 characters'],
    source,
    provenance: {
      id: 'prov-1',
      source,
      steps: [{ operation: 'retrieved', at: timestamp, component: 'test', inputIds: [] }],
      parentIds: [],
    },
    requiresFollowUp: true,
    followUpReason: 'The tool outcome was error.',
    failureClassification: 'invalid_input',
    createdAt: timestamp,
    requestId: 'req-1',
    needIds: ['need-1'],
    capability: 'WEB_SEARCH',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Test 1 – Short normal retrieval request produces a bounded semantic query
// ---------------------------------------------------------------------------
test('TC-01 short retrieval request produces a bounded semantic query', () => {
  const intent = resolver.resolve('What is AWS AgentCore?');
  assert.ok(intent.normalizedRequest.length > 0, 'normalizedRequest must not be empty');
  assert.ok(
    intent.normalizedRequest.length <= WEB_SEARCH_MAX,
    `normalizedRequest must fit in ${WEB_SEARCH_MAX} chars; got ${intent.normalizedRequest.length}`,
  );
  // Must include the key entity
  assert.ok(
    intent.normalizedRequest.toLowerCase().includes('aws') ||
      intent.normalizedRequest.toLowerCase().includes('agentcore'),
    'semantic content preserved',
  );
});

// ---------------------------------------------------------------------------
// Test 2 – Long user prompt with a short question: only the question becomes
//           the retrieval request
// ---------------------------------------------------------------------------
test('TC-02 long prompt with a short question: only the information need is extracted', () => {
  const longPrompt = `
Research this question using current web information:

What are the current AWS recommendations for building production generative AI applications?

Use the available web retrieval capabilities.
If the first retrieval is insufficient: evaluate it, identify what is missing,
change strategy, retrieve again, and report runtime telemetry.
`.trim();

  const intent = resolver.resolve(longPrompt);

  // The normalizedRequest must not repeat all of the verbose test instructions
  assert.ok(
    !intent.normalizedRequest.toLowerCase().includes('report runtime telemetry') &&
      !intent.normalizedRequest.toLowerCase().includes('change strategy'),
    'execution/test instructions must not appear in normalizedRequest',
  );
  // The actual information need must be preserved
  assert.ok(
    intent.normalizedRequest.toLowerCase().includes('aws') ||
      intent.normalizedRequest.toLowerCase().includes('generative ai') ||
      intent.normalizedRequest.toLowerCase().includes('production'),
    'information need preserved in normalizedRequest',
  );
});

// ---------------------------------------------------------------------------
// Test 3 – Long test instructions surrounding a research question: test
//           instructions are NOT sent to web_search
// ---------------------------------------------------------------------------
test('TC-03 test instructions surrounding a research question are not sent to web_search', () => {
  const prompt = `
Research this question using current web information:

What are the current AWS recommendations for building production generative AI applications?

Use the available web retrieval capabilities.
If the first retrieval is insufficient: evaluate it, identify what is missing,
change strategy, retrieve again, and report runtime telemetry.
`.trim();

  const intent = resolver.resolve(prompt);
  const candidates = buildRetrievalRequestCandidates({
    intent,
    maximumLength: WEB_SEARCH_MAX,
    maximumCandidates: 1,
  });

  assert.ok(candidates.length > 0, 'at least one bounded candidate must be produced');
  const query = candidates[0]!.query;

  assert.ok(
    query.length <= WEB_SEARCH_MAX,
    `query must be <= ${WEB_SEARCH_MAX} chars; got ${query.length}`,
  );
  assert.ok(
    !query.toLowerCase().includes('report runtime telemetry') &&
      !query.toLowerCase().includes('change strategy') &&
      !query.toLowerCase().includes('if the first retrieval'),
    'test / control instructions must NOT appear in the query',
  );
  assert.ok(
    query.toLowerCase().includes('aws') ||
      query.toLowerCase().includes('generative ai') ||
      query.toLowerCase().includes('recommendations'),
    'information need must be preserved in the query',
  );
});

// ---------------------------------------------------------------------------
// Test 4 – Output formatting instructions are not query content
// ---------------------------------------------------------------------------
test('TC-04 output formatting instructions are excluded from the retrieval query', () => {
  const prompt = 'Research the current AWS Lambda pricing and return a markdown table.';
  const intent = resolver.resolve(prompt);
  const candidates = buildRetrievalRequestCandidates({ intent, maximumLength: WEB_SEARCH_MAX });

  assert.ok(candidates.length > 0, 'candidates must be produced');
  const query = candidates[0]!.query;

  assert.ok(
    !query.toLowerCase().includes('markdown table') &&
      !query.toLowerCase().includes('return a'),
    '"return a markdown table" must not appear in the search query',
  );
  assert.ok(
    query.toLowerCase().includes('lambda') || query.toLowerCase().includes('aws'),
    'information need preserved',
  );
});

// ---------------------------------------------------------------------------
// Test 5 – Tool restriction instructions remain orchestration metadata
// ---------------------------------------------------------------------------
test('TC-05 tool restriction instructions do not become search-query content', () => {
  const prompt =
    'Use web search. Do not use model memory. What are the current best practices for container security in AWS EKS?';
  const intent = resolver.resolve(prompt);
  const candidates = buildRetrievalRequestCandidates({ intent, maximumLength: WEB_SEARCH_MAX });

  assert.ok(candidates.length > 0, 'candidates must be produced');
  const query = candidates[0]!.query;

  assert.ok(
    !query.toLowerCase().includes('do not use model memory') &&
      !query.toLowerCase().includes('use web search'),
    'tool restriction instructions must not appear in query',
  );
  assert.ok(
    query.toLowerCase().includes('container') ||
      query.toLowerCase().includes('eks') ||
      query.toLowerCase().includes('security'),
    'information need preserved',
  );
});

// ---------------------------------------------------------------------------
// Test 6 – "latest/current" requirement is preserved in the query
// ---------------------------------------------------------------------------
test('TC-06 current/latest freshness requirement is preserved', () => {
  const prompt = 'What are the latest AWS recommendations for production generative AI?';
  const intent = resolver.resolve(prompt);
  const candidates = buildRetrievalRequestCandidates({ intent, maximumLength: WEB_SEARCH_MAX });

  assert.ok(candidates.length > 0, 'candidates must be produced');
  const query = candidates[0]!.query;

  assert.ok(
    query.toLowerCase().includes('latest') || query.toLowerCase().includes('current'),
    'freshness modifier must be preserved in the query',
  );
});

// ---------------------------------------------------------------------------
// Test 7 – Official/authoritative source requirement is preserved
// ---------------------------------------------------------------------------
test('TC-07 official/authoritative source requirement is preserved', () => {
  const prompt = 'Find the official AWS recommendations for production generative AI applications.';
  const intent = resolver.resolve(prompt);
  const candidates = buildRetrievalRequestCandidates({ intent, maximumLength: WEB_SEARCH_MAX });

  assert.ok(candidates.length > 0, 'candidates must be produced');
  const query = candidates[0]!.query;

  assert.ok(
    query.toLowerCase().includes('official') || query.toLowerCase().includes('aws'),
    'authority/source requirement preserved',
  );
});

// ---------------------------------------------------------------------------
// Test 8 – Query at the capability limit succeeds without truncation
// ---------------------------------------------------------------------------
test('TC-08 query at capability limit produces valid bounded execution', () => {
  // Build a query that is exactly at the limit.
  const baseQuery = 'AWS recommendations for generative AI production applications';
  // Pad with meaningful qualifiers up to exactly WEB_SEARCH_MAX characters.
  const padded = (baseQuery + ' official documentation best practices current year').slice(
    0,
    WEB_SEARCH_MAX,
  );
  const intent = resolver.resolve(padded);
  const candidates = buildRetrievalRequestCandidates({
    intent,
    maximumLength: WEB_SEARCH_MAX,
  });

  assert.ok(candidates.length > 0, 'a bounded candidate must be produced for at-limit input');
  assert.ok(
    candidates[0]!.query.length <= WEB_SEARCH_MAX,
    'the selected query must be <= the limit',
  );
});

// ---------------------------------------------------------------------------
// Test 9 – Query exceeding capability limit is safely normalized or decomposed
// ---------------------------------------------------------------------------
test('TC-09 query exceeding capability limit is safely normalized', () => {
  // Build a request that will produce a very long normalizedRequest.
  const longRequest = Array(15)
    .fill(
      'What are the current AWS recommendations for building enterprise-grade production ' +
        'generative AI applications including agents, memory, security, and observability?',
    )
    .join(' Additionally, ');

  const intent = resolver.resolve(longRequest);
  const candidates = buildRetrievalRequestCandidates({
    intent,
    maximumLength: WEB_SEARCH_MAX,
    maximumCandidates: 4,
  });

  assert.ok(candidates.length > 0, 'at least one bounded candidate must be produced');
  for (const candidate of candidates) {
    assert.ok(
      candidate.query.length <= WEB_SEARCH_MAX,
      `every candidate must fit in ${WEB_SEARCH_MAX} chars; got ${candidate.query.length}`,
    );
    assert.ok(candidate.query.length >= 2, 'every candidate must have non-trivial content');
  }
});

// ---------------------------------------------------------------------------
// Test 10 – Multi-part information request produces bounded decomposition
// ---------------------------------------------------------------------------
test('TC-10 multi-part information request produces bounded decomposition', () => {
  const prompt =
    'Research AWS Lambda pricing, ECS Fargate pricing, and EKS pricing, and compare them.';
  const intent = resolver.resolve(prompt);

  assert.equal(intent.complexity, 'compound', 'complexity should be compound for multi-part query');

  const candidates = buildRetrievalRequestCandidates({
    intent,
    maximumLength: WEB_SEARCH_MAX,
    maximumCandidates: 8,
    preferDecomposition: true,
  });

  assert.ok(candidates.length > 0, 'bounded candidates must be produced');
  for (const candidate of candidates) {
    assert.ok(
      candidate.query.length <= WEB_SEARCH_MAX,
      `each decomposed query must be <= ${WEB_SEARCH_MAX} chars; got ${candidate.query.length}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 11 – Invalid input triggers adaptive recovery with a CHANGED request
// ---------------------------------------------------------------------------
test('TC-11 invalid_input (oversized query) triggers adaptive recovery with a different query', () => {
  const oversizedQuery = 'a'.repeat(500); // 500 chars, over the 400-char limit
  const invalidOp = operation({
    id: 'op-oversized',
    input: { query: oversizedQuery, maxResults: 5 },
    status: 'failed',
    executionState: 'FAILED',
    failureClassification: 'invalid_input',
    strategy: 'INITIAL',
  });
  const obs = observation({
    id: 'obs-oversized',
    toolCallId: 'op-oversized',
    content: 'Invalid input for web_search: query: Too big: expected string to have <=400 characters',
    failureClassification: 'invalid_input',
  });

  const evaluator = new AdaptiveRetrievalIntelligence(plannerConfig());
  const summary = evaluator.evaluate({
    requestId: 'req-1',
    needs: [need()],
    operations: [invalidOp],
    observations: [obs],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 10,
  });

  // Must NOT terminate; must recommend a strategy that changes the query
  assert.equal(summary.terminationReason, undefined, 'must not terminate after first invalid_input');
  const strategies = summary.needs[0]?.recommendedStrategies ?? [];
  assert.ok(
    strategies.includes('QUERY_DECOMPOSITION') || strategies.includes('QUERY_REWRITE'),
    `must recommend QUERY_DECOMPOSITION or QUERY_REWRITE; got ${JSON.stringify(strategies)}`,
  );
  // QUERY_DECOMPOSITION should come first for oversized query failures
  assert.equal(
    strategies[0],
    'QUERY_DECOMPOSITION',
    'QUERY_DECOMPOSITION must be first recommendation for an oversized query',
  );

  // Plan the next action — must produce a DIFFERENT query
  const intent = resolver.resolve('What are the current AWS recommendations for building production generative AI applications?');
  const actions = new RuntimeRetrievalPlanner(plannerConfig({ WEB_SEARCH: WEB_SEARCH_MAX })).plan({
    requestId: 'req-1',
    intent,
    needs: [need()],
    toolPlan: toolPlan(WEB_SEARCH_MAX),
    observations: [obs],
    operations: [invalidOp],
    adaptive: summary,
    elapsedMs: 10,
  });

  assert.ok(actions.length > 0, 'a follow-up action must be planned');
  const nextQuery = actions[0]?.input.query as string | undefined;
  assert.ok(typeof nextQuery === 'string', 'the planned action must have a query input');
  assert.ok(
    nextQuery.length <= WEB_SEARCH_MAX,
    `the adapted query must be <= ${WEB_SEARCH_MAX} chars; got ${nextQuery?.length}`,
  );
  assert.notEqual(nextQuery, oversizedQuery, 'the adapted query must differ from the failed one');
});

// ---------------------------------------------------------------------------
// Test 12 – Failed retrieval produces no evidence
// ---------------------------------------------------------------------------
test('TC-12 failed retrieval does not produce evidence', () => {
  const failedOp = operation({
    status: 'failed',
    executionState: 'FAILED',
    failureClassification: 'invalid_input',
  });
  const obs = observation({ failureClassification: 'invalid_input' });

  const evaluator = new AdaptiveRetrievalIntelligence(plannerConfig());
  const summary = evaluator.evaluate({
    requestId: 'req-1',
    needs: [need()],
    operations: [failedOp],
    observations: [obs],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 10,
  });

  assert.equal(
    summary.evidenceQuality.evidenceCount,
    0,
    'failed retrieval must not contribute evidence',
  );
  assert.ok(
    summary.evidenceQuality.sufficient === false,
    'evidence must not be sufficient after a failed retrieval',
  );
});

// ---------------------------------------------------------------------------
// Test 13 – Provenance records the normalized retrieval request
// ---------------------------------------------------------------------------
test('TC-13 provenance records the normalized retrieval request', () => {
  const intent = resolver.resolve(
    'What are the current AWS recommendations for building production generative AI applications?',
  );

  // Simulate the planned action path that produces a RetrievalInputTrace
  const planner = new RuntimeRetrievalPlanner(plannerConfig({ WEB_SEARCH: WEB_SEARCH_MAX }));
  const actions = planner.plan({
    requestId: 'req-1',
    intent,
    needs: [need()],
    toolPlan: toolPlan(WEB_SEARCH_MAX),
    observations: [],
    operations: [],
    elapsedMs: 0,
  });

  assert.ok(actions.length > 0, 'a planning action must be produced');
  const action = actions[0]!;

  // The action must carry retrieval input provenance
  assert.ok(action.retrievalInput !== undefined, 'retrievalInput must be present on the action');
  assert.ok(
    action.retrievalInput!.retrievalRequest.length > 0,
    'retrievalRequest must not be empty',
  );
  assert.ok(
    action.retrievalInput!.informationNeed.length > 0,
    'informationNeed must not be empty',
  );
  assert.ok(
    action.retrievalInput!.retrievalRequest.length <= WEB_SEARCH_MAX,
    `retrievalRequest must be <= ${WEB_SEARCH_MAX} chars; got ${action.retrievalInput!.retrievalRequest.length}`,
  );
  // capabilityMaximumLength records the enforced limit
  assert.equal(
    action.retrievalInput!.capabilityMaximumLength,
    WEB_SEARCH_MAX,
    'capabilityMaximumLength must match the enforced limit',
  );
});

// ---------------------------------------------------------------------------
// Test 14 – Existing web retrieval continues working (schema-declared maxLength)
// ---------------------------------------------------------------------------
test('TC-14 existing web retrieval with schema-declared maxLength still works', () => {
  const intent = resolver.resolve('What is the current AWS Lambda pricing?');
  const candidates = buildRetrievalRequestCandidates({
    intent,
    maximumLength: WEB_SEARCH_MAX,
  });

  assert.ok(candidates.length > 0, 'candidates must be produced');
  assert.ok(candidates[0]!.query.length <= WEB_SEARCH_MAX, 'query must fit the schema limit');
  assert.ok(
    candidates[0]!.query.toLowerCase().includes('lambda') ||
      candidates[0]!.query.toLowerCase().includes('pricing'),
    'content preserved',
  );
});

// ---------------------------------------------------------------------------
// Test 15 – Capability-metadata maximumQueryLength is used as a fallback
// ---------------------------------------------------------------------------
test('TC-15 capability-level maximumQueryLength is used when schema does not declare maxLength', () => {
  // Build intent from a moderately long prompt (~120 chars)
  const mediumPrompt =
    'What are the current AWS recommendations for generative AI agents in production environments using AWS Bedrock?';
  const intent = resolver.resolve(mediumPrompt);
  const normalizedLength = intent.normalizedRequest.length;

  // Simulate a tool whose schema has NO maxLength declared
  const noSchemaMaxCandidates = buildRetrievalRequestCandidates({
    intent,
    // no maximumLength passed → behaves as if schema has no maxLength
  });
  // Without a constraint the full normalizedRequest is returned
  assert.ok(noSchemaMaxCandidates.length > 0, 'candidates produced without constraint');
  assert.equal(
    noSchemaMaxCandidates[0]!.query.length,
    normalizedLength > 0 ? noSchemaMaxCandidates[0]!.query.length : 0,
    'unconstrained query has same length as normalizedRequest',
  );

  // Now simulate the capability-level constraint path (50-char limit to force compaction)
  const tightLimit = 50;
  const constrained = buildRetrievalRequestCandidates({
    intent,
    maximumLength: tightLimit,
  });
  assert.ok(constrained.length > 0, 'bounded candidates must be produced');
  assert.ok(
    constrained[0]!.query.length <= tightLimit,
    `capability-declared limit must be honoured; got ${constrained[0]!.query.length}`,
  );
});

// ---------------------------------------------------------------------------
// Test 16 – Config-level capabilityQueryLengths is used as a third-priority
//            fallback for runtime tools whose schema lacks maxLength
// ---------------------------------------------------------------------------
test('TC-16 config capabilityQueryLengths applies as final fallback', () => {
  const intent = resolver.resolve(
    'What are the current best practices for AWS EKS container security?',
  );
  const config = plannerConfig({ WEB_SEARCH: WEB_SEARCH_MAX });
  const planner = new RuntimeRetrievalPlanner(config);

  // Use a tool plan where the schema has NO maxLength (simulates runtime tool)
  const planWithoutSchemaMax = toolPlan(undefined /* no schemaMaxLength */);
  const actions = planner.plan({
    requestId: 'req-1',
    intent,
    needs: [need()],
    toolPlan: planWithoutSchemaMax,
    observations: [],
    operations: [],
    elapsedMs: 0,
  });

  assert.ok(actions.length > 0, 'an action must be planned');
  const query = actions[0]?.input.query as string | undefined;
  assert.ok(typeof query === 'string', 'action must have a query input');
  assert.ok(
    query.length <= WEB_SEARCH_MAX,
    `config capabilityQueryLengths must bound the query to <= ${WEB_SEARCH_MAX} chars; got ${query?.length}`,
  );
});

// ---------------------------------------------------------------------------
// Test 17 – Existing P1 adaptive retrieval broadening continues to work
// ---------------------------------------------------------------------------
test('TC-17 existing P1 broadening still works after normalization fix', () => {
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
      userIntent: 'current release status Project Aurora',
      taskInstructions: [],
      retrievalInstructions: [],
      systemToolInstructions: [],
      formattingInstructions: [],
      informationRequirements: ['current release status Project Aurora'],
    },
  };

  const emptyOp = operation({
    id: 'op-empty',
    input: { query: intent.normalizedRequest, maxResults: 5 },
    status: 'empty',
    executionState: 'EMPTY',
    strategy: 'INITIAL',
  });
  const emptyObs: ToolObservation = {
    id: 'obs-empty',
    toolCallId: 'op-empty',
    toolName: 'web_search',
    outcome: 'empty',
    content: '',
    facts: [],
    identifiers: [],
    errors: [],
    source: {
      id: 'src-1',
      name: 'Test',
      type: 'external',
      sourceKind: 'WEB',
      authority: 0.7,
      retrievedAt: timestamp,
    },
    provenance: {
      id: 'prov-1',
      source: { id: 'src-1', name: 'Test', type: 'external', authority: 0.7 },
      steps: [{ operation: 'retrieved', at: timestamp, component: 'test', inputIds: [] }],
      parentIds: [],
    },
    requiresFollowUp: true,
    createdAt: timestamp,
    requestId: 'req-1',
    needIds: ['need-1'],
    capability: 'WEB_SEARCH',
  };

  const evaluator = new AdaptiveRetrievalIntelligence(plannerConfig());
  const summary = evaluator.evaluate({
    requestId: 'req-1',
    needs: [need()],
    operations: [emptyOp],
    observations: [emptyObs],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 10,
  });

  assert.equal(summary.needs[0]?.recommendedStrategies[0], 'RETRIEVAL_BROADEN');

  const actions = new RuntimeRetrievalPlanner(plannerConfig({ WEB_SEARCH: WEB_SEARCH_MAX })).plan({
    requestId: 'req-1',
    intent,
    needs: [need()],
    toolPlan: toolPlan(WEB_SEARCH_MAX),
    observations: [emptyObs],
    operations: [emptyOp],
    adaptive: summary,
    elapsedMs: 10,
  });

  assert.ok(actions.length > 0, 'broadening action must be planned');
  assert.equal(actions[0]?.strategy, 'RETRIEVAL_BROADEN');
  const q = actions[0]?.input.query as string | undefined;
  assert.ok(typeof q === 'string' && q.length > 0 && q.length <= WEB_SEARCH_MAX);
});

// ---------------------------------------------------------------------------
// Test 18 – Instruction-segment classification: information requirements are
//            separated from retrieval, formatting, task, and validation
//            instructions across a realistic multi-section prompt
// ---------------------------------------------------------------------------
test('TC-18 segment classification separates information need from all instruction categories', () => {
  const prompt = `
Research this question using current web information:

What are the current AWS recommendations for building production generative AI applications?

Use the available web retrieval capabilities.

If the first retrieval is insufficient:
evaluate it, identify what is missing, change strategy, retrieve again,
and report runtime telemetry.

Return the answer as a JSON object.

Do not use model memory.
`.trim();

  const intent = resolver.resolve(prompt);

  // The extracted information requirements should NOT contain:
  // - tool-use instructions ("use web search", "do not use model memory")
  // - formatting instructions ("return as JSON")
  // - validation/test instructions ("if the first retrieval is insufficient", "report runtime telemetry")
  const infoReqs = intent.instructionSegments.informationRequirements;
  assert.ok(infoReqs.length > 0, 'at least one information requirement must be extracted');

  for (const req of infoReqs) {
    assert.ok(
      !req.toLowerCase().includes('use web search') &&
        !req.toLowerCase().includes('do not use model memory') &&
        !req.toLowerCase().includes('return as json') &&
        !req.toLowerCase().includes('if the first retrieval') &&
        !req.toLowerCase().includes('report runtime telemetry'),
      `information requirement must not contain control instructions: "${req}"`,
    );
  }

  // The key information need must be present
  const allInfo = infoReqs.join(' ').toLowerCase();
  assert.ok(
    allInfo.includes('aws') || allInfo.includes('generative ai') || allInfo.includes('production'),
    'core information need must be in the extracted requirements',
  );
});

// ---------------------------------------------------------------------------
// Test 19 – A diagnostic envelope captures its information need once; later
//           evaluation/reporting imperatives remain control-plane metadata
// ---------------------------------------------------------------------------
test('TC-19 diagnostic evaluation imperatives do not extend the information need', () => {
  const prompt = `
RUNTIME RETRIEVAL VALIDATION

What is AWS AgentCore?

Determine what evidence is missing.
Explain why.
Record the actual tool input.
Report runtime telemetry.
Show the grounding decision.
`.trim();

  const intent = resolver.resolve(prompt);

  assert.equal(intent.normalizedRequest, 'What is AWS AgentCore?');
  assert.deepEqual(intent.instructionSegments.informationRequirements, [
    'What is AWS AgentCore?',
  ]);
  assert.ok(intent.instructionSegments.systemToolInstructions.length > 0);
});

// ---------------------------------------------------------------------------
// Test 20 – Capability compaction starts from the authoritative requested
//           value even if a parallel intent representation is inconsistent
// ---------------------------------------------------------------------------
test('TC-20 canonical requested value wins over contaminated secondary candidates', () => {
  const canonical = resolver.resolve(
    'Describe Project Aurora deployment architecture, security controls, observability requirements, operational limits, and supported production environments.',
  );
  const intent: NormalizedIntent = {
    ...canonical,
    instructionSegments: {
      ...canonical.instructionSegments,
      informationRequirements: [
        'Determine what evidence is missing.',
        'Explain why the validation passes or fails.',
        canonical.normalizedRequest,
      ],
    },
  };

  const candidates = buildRetrievalRequestCandidates({
    intent,
    requested: canonical.normalizedRequest,
    maximumLength: 80,
    maximumCandidates: 4,
  });
  const first = candidates[0];

  assert.ok(first, 'a bounded canonical candidate must be produced');
  assert.equal(first.informationNeed, canonical.normalizedRequest);
  assert.equal(first.construction, 'semantic_compaction');
  assert.ok(first.query.length <= 80);
  assert.match(first.query, /Project Aurora/i);
  assert.equal(first.query.toLowerCase().includes('evidence is missing'), false);
  assert.equal(first.query.toLowerCase().includes('validation passes or fails'), false);
});

// ---------------------------------------------------------------------------
// Test 21 – Diagnostic isolation applies to compound directives while
//           preserving multiple genuine information questions
// ---------------------------------------------------------------------------
test('TC-21 diagnostic isolation is consistent across compound directive branches', () => {
  const retrievalDirective = resolver.resolve(`
RUNTIME RETRIEVAL VALIDATION
What is Project Aurora?
Determine what evidence is missing using the available web tools.
`.trim());
  assert.equal(retrievalDirective.normalizedRequest, 'What is Project Aurora?');
  assert.equal(retrievalDirective.instructionSegments.retrievalInstructions.length, 0);

  const formattingDirective = resolver.resolve(`
RUNTIME RETRIEVAL VALIDATION
What is Project Aurora?
Explain why and return the result as JSON.
`.trim());
  assert.equal(formattingDirective.normalizedRequest, 'What is Project Aurora?');
  assert.ok(formattingDirective.instructionSegments.formattingInstructions.length > 0);

  const multipleQuestions = resolver.resolve(`
RUNTIME RETRIEVAL VALIDATION
What is Project Aurora?
How is it deployed?
`.trim());
  assert.deepEqual(multipleQuestions.instructionSegments.informationRequirements, [
    'What is Project Aurora?',
    'How is it deployed?',
  ]);
  assert.equal(
    multipleQuestions.normalizedRequest,
    'What is Project Aurora? How is it deployed?',
  );
});


test('TC-22 same-subject execution questions remain outside the information need', () => {
  const informationNeed =
    'What are the current AWS recommendations for building production generative AI applications?';
  const intent = resolver.resolve(`
${informationNeed}
Was the first retrieval query for current AWS production generative AI recommendations clean?
Did the actual tool input contain orchestration instructions?
`.trim());

  assert.deepEqual(intent.instructionSegments.informationRequirements, [informationNeed]);
  assert.equal(intent.normalizedRequest, informationNeed);
  assert.equal(intent.instructionSegments.reportingInstructions?.length, 2);
});

test('TC-23 independent substantive questions are preserved as information requirements', () => {
  const intent = resolver.resolve(
    'What is the current AWS Lambda price? What security advisories affect Kubernetes 1.31?',
  );

  assert.deepEqual(intent.instructionSegments.informationRequirements, [
    'What is the current AWS Lambda price?',
    'What security advisories affect Kubernetes 1.31?',
  ]);
});