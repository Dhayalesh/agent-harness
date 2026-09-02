/**
 * P1 Retrieval-Plan Boundary Regression Tests
 *
 * Acceptance authority: ACTUAL tool arguments captured at invocation time.
 * Internal planner output alone is NOT sufficient proof of a clean execution.
 *
 * Root cause fixed: isExecutionMetaRequirement used \binstruction\b (singular)
 * which did not match "instructions" (plural) because no word boundary exists
 * between the letters n and s.  Clauses containing "test/control/reporting
 * instructions" therefore escaped execution-meta classification and entered
 * informationRequirements verbatim.
 *
 * Test map (matches P1_RETRIEVAL_BOUNDARY_FIX.md §8):
 *   T1 – P1 contamination pattern (slash-marker + Attempt-N + information need)
 *   T2 – Raw prompt CANNOT be used as a fallback web_search query
 *   T3 – No normalized plan → retrieval denied before tool invocation
 *   T4 – Normalized plan → capability input is the only production path
 *   T5 – Provenance normalizedRetrievalRequest === actual tool input
 *   T6 – web_fetch extraction prompt cannot contain test/control instructions
 *   T7 – Adaptive Attempt 2 derived from normalized Attempt-1 observation/gap
 *   T8 – Integration: actual tool.execute() arguments captured, not planner output
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  AdaptiveRetrievalIntelligence,
  AllowAllPermissionHandler,
  ContextIntelligenceEngine,
  DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  IntentResolver,
  RuntimeRetrievalPlanner,
  ScriptedModelProvider,
  createAgentSession,
  type AdaptiveRetrievalSummary,
  type CapabilityMetadata,
  type ContextCapability,
  type ContextNeed,
  type ContextSourceKind,
  type NormalizedIntent,
  type RuntimeRetrievalOperation,
  type SelectedCapability,
  type Tool,
  type ToolObservation,
  type ToolPlan,
} from '../../src/index.js';
import { stableHash } from '../../src/context-intelligence/utils.js';

// ---------------------------------------------------------------------------
// Shared configuration (mirrors retrieval-capability-inputs.test.ts)
// ---------------------------------------------------------------------------

type ExecutableContextCapability = Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
type SearchInput = { query: string; maxResults?: number | undefined };
type FetchInput = { url: string; prompt?: string | undefined };

const resolver = new IntentResolver();
const timestamp = '2026-09-01T00:00:00.000Z';

/**
 * The URL the scripted web_search returns. web_fetch must use exactly this URL —
 * proving it came from an actual search result and not from the raw prompt.
 */
const RESULT_URL =
  'https://aws.amazon.com/blogs/machine-learning/production-generative-ai-guidance/';

const config = {
  ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  budgets: {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets,
    maxLoopMilliseconds: 60_000,
  },
  query: {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query,
    capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 },
  },
};

// ---------------------------------------------------------------------------
// The P1 contamination prompt
//
// This is the exact structural pattern that triggered the production P1 failure:
//   1. A clean research question on its own paragraph.
//   2. An ALL-CAPS sentence containing "test/control/reporting" (slash-separated)
//      followed by "MUST NOT … contain" — the clause that escaped execution-meta
//      classification due to the \binstruction\b vs "instructions" bug.
//   3. An "Attempt 1 need …" clause — caught by the new ^Attempt\s+\d+\b rule.
//   4. A continuation of test evaluation language that must not reach the tool.
// ---------------------------------------------------------------------------

const P1_INFORMATION_NEED =
  'What are the current AWS recommendations for building production generative AI applications?';

const P1_CONTAMINATION_PROMPT = `
${P1_INFORMATION_NEED}

AWS AI ALL RAG TEST CONTROL MUST NOT current NOT contain any test/control/reporting instructions.
Attempt 1 need production-oriented comparison guidance generative applications covering these dimensions architecture application design model selection evaluation production performance capacity planning observability monitoring security governance responsible reliability answer should identify apply.

Use current official AWS sources and return a structured comparison.
`.trim();

/**
 * Terms that must NEVER appear in any retrieval capability argument.
 * These come directly from the contaminated query observed in the P1 runtime.
 */
const FORBIDDEN_IN_RETRIEVAL_ARGS = [
  'test/control',
  'test/control/reporting',
  'reporting instructions',
  'must not current not',
  'attempt 1 need',
  'covering these dimensions',
  'answer should identify apply',
  'production performance capacity planning observability monitoring security governance responsible reliability',
];

function assertClean(value: string, label: string): void {
  for (const term of FORBIDDEN_IN_RETRIEVAL_ARGS) {
    assert.equal(
      value.toLowerCase().includes(term.toLowerCase()),
      false,
      `${label} must not contain forbidden term "${term}"\n  actual: "${value}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers (mirrors retrieval-capability-inputs.test.ts)
// ---------------------------------------------------------------------------

function selectedCapability(
  name: string,
  capability: ExecutableContextCapability,
  properties: Record<string, unknown>,
  required: readonly string[],
  inputAliases?: Readonly<Record<string, string>>,
): SelectedCapability {
  const metadata: CapabilityMetadata = {
    id: `tool:${name}`,
    name,
    description: `${capability} test capability`,
    kind: capability.startsWith('WEB_') ? 'network' : 'read',
    keywords: [name, capability.toLowerCase()],
    entityTypes: [],
    operations: [capability.includes('SEARCH') || capability.includes('DISCOVERY') ? 'search' : 'read'],
    sourceIds: [],
    sourceKinds: sourceKindsFor(capability),
    authority: 0.95,
    cost: 0.1,
    latency: 0.1,
    preconditions: [...required],
    effects: ['reads data'],
    limitations: [],
    policyLabels: [],
    enabled: true,
    provides: [capability],
    ...(inputAliases === undefined ? {} : { inputAliases }),
  };
  return {
    capability: metadata,
    score: 1,
    reasons: ['test'],
    descriptor: {
      name,
      description: metadata.description,
      inputSchema: {
        type: 'object',
        properties,
        required: [...required],
        additionalProperties: false,
      },
    },
  };
}

function sourceKindsFor(capability: ExecutableContextCapability): ContextSourceKind[] {
  if (capability.startsWith('WEB_')) return ['WEB'];
  if (capability.startsWith('FILE_')) return ['FILE'];
  if (capability.startsWith('ARTIFACT_')) return ['ARTIFACT'];
  return [];
}

function webCapabilities(): SelectedCapability[] {
  return [
    selectedCapability(
      'web_search',
      'WEB_SEARCH',
      {
        query: { type: 'string', maxLength: 400 },
        maxResults: { type: 'integer', minimum: 1, maximum: 20 },
      },
      ['query'],
    ),
    selectedCapability(
      'web_fetch',
      'WEB_FETCH',
      { url: { type: 'string' }, prompt: { type: 'string', maxLength: 400 } },
      ['url'],
      { query: 'prompt' },
    ),
  ];
}

function contextNeed(intent: NormalizedIntent): ContextNeed {
  return {
    id: 'need-1',
    type: 'CURRENT_EXTERNAL_INFORMATION',
    required: true,
    requiredInformation: ['requested evidence'],
    missingInformation: ['current external evidence'],
    reason: 'The request depends on externally observable information.',
    sourceRequirement: 'external',
    sourceKinds: ['WEB'],
    freshnessRequirement: 'CURRENT',
    authorityRequirement: 'AUTHORITATIVE',
    scope: { conversationId: 'conv-1', taskId: 'task-1', namespaces: ['test'] },
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
      authorityRequirement: 'AUTHORITATIVE',
      freshnessRequirement: 'CURRENT',
    },
    priority: 'critical',
    status: 'missing',
    inputs: { query: intent.normalizedRequest },
    normalizedRetrievalRequest: {
      informationNeed: intent.normalizedRequest,
      request: intent.normalizedRequest,
    },
  };
}

function toolPlan(need: ContextNeed, selected: readonly SelectedCapability[]): ToolPlan {
  const alternatives: Partial<Record<ExecutableContextCapability, readonly string[]>> = {};
  for (const entry of selected) {
    for (const cap of entry.capability.provides ?? []) {
      if (cap === 'WEB_RETRIEVAL') continue;
      const exec = cap as ExecutableContextCapability;
      alternatives[exec] = [...(alternatives[exec] ?? []), entry.capability.name];
    }
  }
  const provided = Object.keys(alternatives) as ExecutableContextCapability[];
  return {
    goal: 'P1 boundary regression test',
    selected,
    excluded: [],
    argumentRequirements: Object.fromEntries(
      selected.map((e) => [
        e.capability.name,
        (e.descriptor?.inputSchema.required as readonly string[] | undefined) ?? [],
      ]),
    ),
    requirements: [need.capabilityRequirement],
    resolutions: [
      {
        needId: need.id,
        requested: need.requiredCapability,
        requiredCapabilities: provided,
        permittedCapabilities: provided,
        status: 'available',
        toolNames: selected.map((e) => e.capability.name),
        alternatives,
        reason: 'Test capabilities are available.',
      },
    ],
  };
}

function plan(
  intent: NormalizedIntent,
  need: ContextNeed,
  selected: readonly SelectedCapability[],
  options: {
    operations?: readonly RuntimeRetrievalOperation[];
    observations?: readonly ToolObservation[];
    adaptive?: AdaptiveRetrievalSummary;
  } = {},
) {
  return new RuntimeRetrievalPlanner(config).plan({
    requestId: 'request-1',
    intent,
    needs: [need],
    toolPlan: toolPlan(need, selected),
    observations: options.observations ?? [],
    operations: options.operations ?? [],
    ...(options.adaptive === undefined ? {} : { adaptive: options.adaptive }),
    elapsedMs: 1,
  });
}

function operation(
  input: Record<string, unknown>,
  partial: Partial<RuntimeRetrievalOperation> = {},
): RuntimeRetrievalOperation {
  return {
    id: partial.id ?? 'op-1',
    requestId: 'request-1',
    needId: 'need-1',
    capability: partial.capability ?? 'WEB_SEARCH',
    phase: partial.phase ?? 'discovery',
    toolName: partial.toolName ?? 'web_search',
    input,
    attemptKey: partial.attemptKey ?? stableHash({ toolName: 'web_search', input }),
    strategy: partial.strategy ?? 'INITIAL',
    iteration: partial.iteration ?? 1,
    status: partial.status ?? 'failed',
    executionState: partial.executionState ?? 'FAILED',
    resourceState: partial.resourceState ?? 'RETRIEVAL_FAILED',
    startedAt: timestamp,
    completedAt: timestamp,
    ...partial,
  };
}

function observation(partial: Partial<ToolObservation> = {}): ToolObservation {
  const source = {
    id: 'src-1',
    name: 'AWS search result',
    type: 'external' as const,
    sourceKind: 'WEB' as const,
    authority: 0.9,
    retrievedAt: timestamp,
    uri: RESULT_URL,
  };
  return {
    id: partial.id ?? 'obs-1',
    toolCallId: partial.toolCallId ?? 'op-1',
    toolName: partial.toolName ?? 'web_search',
    outcome: partial.outcome ?? 'error',
    content: partial.content ?? 'Retrieval failed.',
    facts: partial.facts ?? [],
    identifiers: [],
    errors: partial.errors ?? ['Retrieval failed.'],
    source,
    provenance: {
      id: 'prov-1',
      source,
      steps: [{ operation: 'retrieved', at: timestamp, component: 'test', inputIds: [] }],
      parentIds: [],
    },
    requiresFollowUp: partial.requiresFollowUp ?? true,
    createdAt: timestamp,
    requestId: 'request-1',
    needIds: ['need-1'],
    capability: partial.capability ?? 'WEB_SEARCH',
    links: partial.links ?? [],
    ...partial,
  };
}

function retrievalMetadata(
  name: string,
  capability: 'WEB_SEARCH' | 'WEB_FETCH',
  inputAliases?: Readonly<Record<string, string>>,
): CapabilityMetadata {
  return {
    id: `tool:${name}`,
    name,
    description: capability === 'WEB_SEARCH' ? 'Search the live web' : 'Fetch a web URL',
    kind: 'network',
    keywords: ['web', capability === 'WEB_SEARCH' ? 'search' : 'fetch'],
    entityTypes: [],
    operations: [capability === 'WEB_SEARCH' ? 'search' : 'fetch'],
    sourceIds: [],
    sourceKinds: ['WEB'],
    authority: 0.9,
    cost: 0.1,
    latency: 0.1,
    preconditions: capability === 'WEB_SEARCH' ? ['query'] : ['url'],
    effects: ['reads data'],
    limitations: [],
    policyLabels: [],
    enabled: true,
    provides: [capability],
    maximumQueryLength: 400,
    ...(inputAliases === undefined ? {} : { inputAliases }),
  };
}

function runtimeTools(
  captured: { searches: SearchInput[]; fetches: FetchInput[] },
  options: { failFirstSearch?: boolean } = {},
): [Tool<SearchInput>, Tool<FetchInput>] {
  const searchSchema = z.object({
    query: z.string().max(400),
    maxResults: z.number().optional(),
  });
  const fetchSchema = z.object({
    url: z.string().url(),
    prompt: z.string().max(400).optional(),
  });
  return [
    {
      name: 'web_search',
      description: 'Search the live web for current information',
      inputSchema: searchSchema,
      jsonSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 400 },
          maxResults: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      kind: 'network',
      concurrencySafe: true,
      contextMetadata: retrievalMetadata('web_search', 'WEB_SEARCH'),
      async execute(input) {
        captured.searches.push(structuredClone(input));
        if (options.failFirstSearch && captured.searches.length === 1) {
          return { content: 'Invalid input for web_search query.', isError: true };
        }
        return {
          content: JSON.stringify({
            results: [
              {
                title: 'AWS production generative AI guidance',
                url: RESULT_URL,
                snippet: 'Official AWS guidance for production generative AI applications.',
              },
            ],
          }),
          metadata: { url: RESULT_URL },
        };
      },
    },
    {
      name: 'web_fetch',
      description: 'Fetch an external web URL and extract relevant information',
      inputSchema: fetchSchema,
      jsonSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          prompt: { type: 'string', maxLength: 400 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      kind: 'network',
      concurrencySafe: true,
      contextMetadata: retrievalMetadata('web_fetch', 'WEB_FETCH', { query: 'prompt' }),
      async execute(input) {
        captured.fetches.push(structuredClone(input));
        return {
          content:
            'AWS recommends governed data, security controls, observability, evaluation, and cost management for production generative AI.',
          metadata: { url: input.url },
        };
      },
    },
  ];
}

async function executePrompt(
  prompt: string,
  options: { failFirstSearch?: boolean } = {},
): Promise<{ searches: SearchInput[]; fetches: FetchInput[] }> {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'AWS production generative AI guidance answer.' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: runtimeTools(captured, options),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: {
      config: {
        query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } },
      },
    },
  });
  for await (const _event of session.run({ prompt })) {
    /* consume complete CI retrieval loop */
  }
  return captured;
}

// ---------------------------------------------------------------------------
// T1: P1 contamination pattern
//     The EXACT prompt structure from the production failure.
//     Both slash-marker ("test/control/reporting") and "Attempt N need" clauses
//     must be stripped before the information need reaches the tool.
// ---------------------------------------------------------------------------

test('T1: P1 slash-marker and Attempt-N clauses are stripped — actual web_search query contains only the information need', async () => {
  // Step A — normalization must isolate the information need
  const intent = resolver.resolve(P1_CONTAMINATION_PROMPT);
  assert.equal(
    intent.normalizedRequest,
    P1_INFORMATION_NEED,
    'normalizedRequest must equal exactly the clean information need',
  );
  assert.equal(intent.instructionSegments.informationRequirements.length, 1);
  assert.equal(intent.instructionSegments.informationRequirements[0], P1_INFORMATION_NEED);

  // Step B — planner must produce a clean action
  const need = contextNeed(intent);
  const actions = plan(intent, need, webCapabilities());
  const action = actions[0];
  assert.ok(action, 'a retrieval action must be planned');
  assert.equal(action.toolName, 'web_search');
  const plannedQuery = String(action.input.query ?? '');
  assert.equal(plannedQuery, action.retrievalInput?.retrievalRequest);
  assertClean(plannedQuery, 'planned action.input.query');

  // Step C — ACTUAL tool invocation — the acceptance authority
  const captured = await executePrompt(P1_CONTAMINATION_PROMPT);
  assert.ok(captured.searches.length >= 1, 'web_search must execute');
  const actualQuery = captured.searches[0]!.query;
  assertClean(actualQuery, 'actual web_search query (tool.execute argument)');
  assert.match(actualQuery, /current AWS recommendations/i);
  assert.match(actualQuery, /production generative AI/i);
  assert.notEqual(actualQuery, P1_CONTAMINATION_PROMPT);
});

// ---------------------------------------------------------------------------
// T2: Raw prompt CANNOT be used as a fallback web_search query
// ---------------------------------------------------------------------------

test('T2: raw prompt never reaches tool.execute() as a query — no raw-prompt fallback', async () => {
  const captured = await executePrompt(P1_CONTAMINATION_PROMPT);
  for (const s of captured.searches) {
    assert.notEqual(s.query, P1_CONTAMINATION_PROMPT);
    assert.ok(s.query.length <= 400, `query must be bounded (was ${s.query.length})`);
  }
  for (const f of captured.fetches) {
    if (f.prompt !== undefined) {
      assert.notEqual(f.prompt, P1_CONTAMINATION_PROMPT);
      assert.ok(f.prompt.length <= 400);
    }
  }
});

// ---------------------------------------------------------------------------
// T3: No normalized plan → retrieval denied BEFORE tool invocation (Req G)
//     A prompt containing ONLY test/control language produces no information need.
// ---------------------------------------------------------------------------

test('T3: instruction-only prompt produces no normalized plan — retrieval denied before tool invocation', async () => {
  const controlOnlyPrompt =
    'TEST CONTROL: MUST NOT contain any test/control/reporting instructions. ' +
    'Attempt 1: Report PASS or FAIL. Show actual tool input. Show execution state. ' +
    'Attempt 2: Retry if first attempt failed.';

  const intent = resolver.resolve(controlOnlyPrompt);
  assert.equal(intent.normalizedRequest, '', 'control-only prompt must produce empty normalizedRequest');
  assert.equal(intent.instructionSegments.informationRequirements.length, 0);

  const captured = await executePrompt(controlOnlyPrompt);
  assert.deepEqual(captured.searches, [], 'web_search must NOT execute');
  assert.deepEqual(captured.fetches, [], 'web_fetch must NOT execute');
});

// ---------------------------------------------------------------------------
// T4: Normalized plan → capability input is the ONLY production path (Req A, B)
//     An unplanned retrieval attempt (not from a CI plan) must be blocked.
// ---------------------------------------------------------------------------

test('T4: unplanned retrieval using the raw prompt is blocked before tool invocation', async () => {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const [search, fetch] = runtimeTools(captured);
  const engine = new ContextIntelligenceEngine({
    config: { query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } } },
  });
  await engine.prepare({
    request: P1_CONTAMINATION_PROMPT,
    messages: [],
    tools: [search, fetch] as Tool[],
    systemPrompt: '',
    scope: { conversationId: 'conv-1', taskId: 'task-1', namespaces: ['test'] },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  });

  // The raw-prompt unplanned call must be blocked
  const unplanned = engine.bindRuntimeToolInput({
    tool: search,
    toolCallId: 'model-generated-id',
    proposedInput: { query: P1_CONTAMINATION_PROMPT, maxResults: 5 },
  });
  assert.equal(unplanned.allowed, false);
  if (!unplanned.allowed) {
    assert.match(unplanned.reason, /normalized Context Intelligence retrieval plan/i);
  }

  // bindRuntimeToolInput must not have invoked the tool
  assert.deepEqual(captured.searches, []);
});

// ---------------------------------------------------------------------------
// T5: Provenance normalizedRetrievalRequest === actual tool input (Req F)
// ---------------------------------------------------------------------------

test('T5: provenance normalizedRetrievalRequest is semantically identical to the actual captured tool argument', async () => {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const [search, fetch] = runtimeTools(captured);
  const engine = new ContextIntelligenceEngine({
    config: { query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } } },
  });
  const prepareInput = {
    request: P1_CONTAMINATION_PROMPT,
    messages: [],
    tools: [search, fetch] as Tool[],
    systemPrompt: '',
    scope: { conversationId: 'conv-1', taskId: 'task-1', namespaces: ['test'] },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  };
  const first = await engine.prepare(prepareInput);
  const action = first.contract.directive.actions[0];
  assert.ok(action);

  // Raw request preserved in contract; normalized request is clean
  assert.equal(first.contract.rawRequest, P1_CONTAMINATION_PROMPT);
  assert.notEqual(first.contract.intent.normalizedRequest, P1_CONTAMINATION_PROMPT);
  assertClean(first.contract.intent.normalizedRequest, 'contract.intent.normalizedRequest');

  // action.input.query === retrievalInput.retrievalRequest (same normalized object)
  assert.equal(action.input.query, action.retrievalInput?.retrievalRequest);
  assertClean(String(action.input.query), 'action.input.query');

  // Execute and record actual invocation
  const parsed = search.inputSchema.parse(action.input);
  const receipt = engine.recordRuntimeToolInvocation({
    tool: search,
    toolCallId: action.id,
    actualToolInput: parsed,
    sessionId: 'session-1',
    turnId: 'turn-1',
  });
  assert.equal(receipt.allowed, true);
  const output = await search.execute(parsed, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: action.id,
    workingDirectory: '.',
    signal: new AbortController().signal,
    messages: [],
    reportProgress() {},
  });
  await engine.processObservation({
    tool: search,
    toolCallId: action.id,
    output,
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolResultReturned: true,
  });
  const second = await engine.prepare(prepareInput);
  const observed = second.contract.observations.find((e) => e.toolCallId === action.id);
  const traced = observed?.provenance.steps.find(
    (step) => step.details?.normalizedRetrievalRequest !== undefined,
  );

  // THE KEY ASSERTION: provenance record = what was actually passed to tool.execute()
  assert.equal(captured.searches[0]?.query, action.input.query);
  assert.equal(traced?.details?.normalizedRetrievalRequest, captured.searches[0]?.query);
  assert.equal(traced?.details?.normalizedRetrievalRequest, action.retrievalInput?.retrievalRequest);
  assert.equal(traced?.details?.retrievalArgument, 'query');
  assertClean(String(traced?.details?.normalizedRetrievalRequest), 'provenance.normalizedRetrievalRequest');
});

// ---------------------------------------------------------------------------
// T6: web_fetch extraction prompt cannot contain test/control instructions (Req H)
//     The fetch URL must come from an actual search result; the prompt must be
//     derived only from the normalized information need.
// ---------------------------------------------------------------------------

test('T6: web_fetch receives URL from actual search result and clean prompt derived from normalized need', async () => {
  const captured = await executePrompt(P1_CONTAMINATION_PROMPT);
  assert.ok(captured.fetches.length >= 1, 'web_fetch must execute after successful search');

  for (const fetchCall of captured.fetches) {
    // URL must come from an actual search result, not from the raw prompt
    assert.equal(fetchCall.url, RESULT_URL, 'web_fetch URL must come from actual search results');
    if (fetchCall.prompt !== undefined) {
      assertClean(fetchCall.prompt, 'web_fetch prompt');
      assert.match(fetchCall.prompt, /current AWS recommendations/i);
      assert.ok(
        fetchCall.prompt.length <= 400,
        `web_fetch prompt must be bounded (was ${fetchCall.prompt.length})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// T7: Adaptive Attempt 2 derived from normalized Attempt-1 observation/gap (Req I, J)
//     After a failed Attempt 1, the planner must derive Attempt 2 from the
//     stable normalized need — NOT from the raw prompt.
// ---------------------------------------------------------------------------

test('T7: adaptive Attempt 2 is derived from the normalized need and evidence gap, not the raw prompt', () => {
  const intent = resolver.resolve(P1_CONTAMINATION_PROMPT);
  const need = contextNeed(intent);
  const initial = plan(intent, need, webCapabilities())[0]!;
  assert.ok(initial);
  assertClean(String(initial.input.query), 'Attempt 1 query');

  const failedOp = operation(initial.input, {
    id: initial.id,
    attemptKey: initial.attemptKey,
    status: 'failed',
    executionState: 'FAILED',
    resourceState: 'RETRIEVAL_FAILED',
    failureClassification: 'invalid_input',
    ...(initial.retrievalInput === undefined ? {} : { retrievalInput: initial.retrievalInput }),
  });
  const failedObs = observation({
    toolCallId: initial.id,
    outcome: 'error',
    content: 'web_search rejected the query.',
    errors: ['web_search rejected the query.'],
    failureClassification: 'invalid_input',
  });

  const adaptive = new AdaptiveRetrievalIntelligence(config).evaluate({
    requestId: 'request-1',
    needs: [need],
    operations: [failedOp],
    observations: [failedObs],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 2,
  });

  const second = plan(intent, need, webCapabilities(), {
    operations: [failedOp],
    observations: [failedObs],
    adaptive,
  })[0];
  assert.ok(second, 'Attempt 2 must be planned after a genuine Attempt 1 failure');

  const secondQuery = String(second.input.query ?? '');
  assertClean(secondQuery, 'Attempt 2 query');
  assert.match(secondQuery, /AWS/i, 'Attempt 2 must retain the information need entity');
  assert.notEqual(secondQuery, initial.input.query, 'Attempt 2 must differ from Attempt 1');
  assert.notEqual(secondQuery, P1_CONTAMINATION_PROMPT, 'Attempt 2 must not be the raw prompt');
  assert.equal(secondQuery, second.retrievalInput?.retrievalRequest);
});

// ---------------------------------------------------------------------------
// T8: Integration — ACTUAL tool arguments captured at tool.execute() time (Req F)
//     This test runs the full AgentSession loop with a failing first search and
//     captures the exact arguments that reached tool.execute() — not planner
//     output.  Invocation telemetry must match the captured arguments exactly.
// ---------------------------------------------------------------------------

test('T8: integration — actual tool.execute() arguments are clean for both web_search attempts and web_fetch', async () => {
  const telemetry: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const engine = new ContextIntelligenceEngine({
    config: { query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } } },
    onTelemetry(event) {
      telemetry.push({ event: event.event, data: event.data });
    },
  });
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'AWS production generative AI guidance answer.' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: runtimeTools(captured, { failFirstSearch: true }),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: engine,
  });

  for await (const _event of session.run({ prompt: P1_CONTAMINATION_PROMPT })) {
    /* consume complete retrieval loop */
  }

  // ── web_search: at least 2 attempts (1 failed → 1 adapted) ─────────────
  assert.ok(captured.searches.length >= 2, 'failed first search must trigger adaptive second attempt');

  for (let i = 0; i < captured.searches.length; i++) {
    const actual = captured.searches[i]!;
    assertClean(actual.query, `actual web_search query attempt ${i + 1}`);
    assert.match(actual.query, /AWS/i, `attempt ${i + 1} must retain the information need entity`);
    assert.notEqual(actual.query, P1_CONTAMINATION_PROMPT);
    assert.ok(actual.query.length <= 400);
  }

  // Attempt 2 must be different from Attempt 1 (genuine adaptation, not blind retry)
  assert.notEqual(captured.searches[1]?.query, captured.searches[0]?.query);

  // ── web_fetch: URL from actual search result ────────────────────────────
  assert.ok(captured.fetches.length >= 1, 'successful adapted search must lead to web_fetch');
  assert.equal(captured.fetches[0]?.url, RESULT_URL);
  if (captured.fetches[0]?.prompt !== undefined) {
    assertClean(captured.fetches[0].prompt, 'actual web_fetch prompt');
    assert.ok(captured.fetches[0].prompt.length <= 400);
  }

  // ── Invocation telemetry must record the exact arguments ────────────────
  const invocations = telemetry.filter((e) => e.event === 'context-intelligence.invocation');
  assert.ok(invocations.length > 0, 'invocation telemetry must be emitted');

  const searchInvocations = invocations.filter((e) => e.data.tool === 'web_search');
  for (let i = 0; i < searchInvocations.length; i++) {
    const inv = searchInvocations[i]!;
    // actual_tool_input in telemetry must match what tool.execute() actually received
    assert.deepEqual(
      inv.data.actual_tool_input,
      captured.searches[i],
      `invocation telemetry must record exact actual input for web_search attempt ${i + 1}`,
    );
    assertClean(
      String((inv.data.actual_tool_input as SearchInput | undefined)?.query ?? ''),
      `invocation telemetry actual_tool_input.query for attempt ${i + 1}`,
    );
  }

  const fetchInvocations = invocations.filter((e) => e.data.tool === 'web_fetch');
  if (fetchInvocations.length > 0) {
    assert.deepEqual(fetchInvocations[0]?.data.actual_tool_input, captured.fetches[0]);
  }

  // ── Operation records must carry invocation receipts ────────────────────
  // (verifies recordRuntimeToolInvocation was called for every executed action)
  const observations = telemetry.filter(
    (e) =>
      e.event === 'context-intelligence.observation' &&
      e.data.retrieval_attempt_number !== undefined,
  );
  assert.ok(observations.length >= 2, 'at least 2 retrieval observations must be recorded');
  for (const obs of observations) {
    assert.notEqual(obs.data.actual_tool_input, undefined, 'every observation must have actual_tool_input');
  }
});
