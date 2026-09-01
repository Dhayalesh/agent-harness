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

type ExecutableContextCapability = Exclude<ContextCapability, 'WEB_RETRIEVAL'>;
type SearchInput = { query: string; maxResults?: number | undefined };
type FetchInput = { url: string; prompt?: string | undefined };

const resolver = new IntentResolver();
const timestamp = '2026-09-01T00:00:00.000Z';
const selectedResultUrl =
  'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html';
const diagnosticPrompt = `
RUNTIME TEST — VERIFY CLEAN RETRIEVAL INPUT

Use current web information to answer:

"What is AWS AgentCore?"

This is a runtime validation test.
Use the existing web_search capability.
Do not use GitHub search.
Do not use MCP as a substitute for web retrieval.
Do not modify anything.

CRITICAL:
The test passes only if the actual tool input contains the information need and nothing else.
The test fails if any orchestration instruction reaches retrieval.
Capture the selected capability.
Capture the actual tool call.
Capture the actual input.
Capture the normalized retrieval request.
Record the execution state.
Record the retrieval state.
Record whether evidence was admitted.
Verify the search query before execution.
Verify the fetch prompt before execution.
Validate that no raw prompt was copied.
Validate that output requirements stay separate.
Validate that tool restrictions stay separate.
Validate that telemetry requirements stay separate.
Show the Context Need.
Show the Selected Capability.
Show the Actual Tool Call.
Show the Actual Input.
Show the Observation.
Show the Evidence.
Determine what evidence is missing.
Show the Evaluation.
Explain why.
Show the Grounding Decision.
Report runtime telemetry.
Report PASS or FAIL.
The purpose of this test is retrieval-input isolation.
The final answer is not sufficient proof.
A successful search with a polluted query is a failure.
False provenance is a failure.
Do not claim success from answer quality.
Do not retry with the raw prompt.
If retrieval is insufficient, adapt from the information need.
If the tool fails, keep the operation failed.
At the end, provide only the requested validation report.
`.trim();

function diagnosticPromptFor(informationNeed: string): string {
  return diagnosticPrompt.replace('"What is AWS AgentCore?"', `"${informationNeed}"`);
}

const config = {
  ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
  budgets: {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets,
    maxLoopMilliseconds: 60_000,
  },
  query: {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query,
    capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400, MCP_RETRIEVAL: 400 },
  },
};

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
    operations: [
      capability.includes('SEARCH') || capability.includes('DISCOVERY') ? 'search' : 'read',
    ],
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
  if (capability === 'MCP_RETRIEVAL') return ['MCP'];
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

function toolPlan(need: ContextNeed, selected: readonly SelectedCapability[]): ToolPlan {
  const alternatives: Partial<Record<ExecutableContextCapability, readonly string[]>> = {};
  for (const entry of selected) {
    for (const capability of entry.capability.provides ?? []) {
      if (capability === 'WEB_RETRIEVAL') continue;
      const executable = capability as ExecutableContextCapability;
      alternatives[executable] = [...(alternatives[executable] ?? []), entry.capability.name];
    }
  }
  const provided = Object.keys(alternatives) as ExecutableContextCapability[];
  return {
    goal: 'test retrieval input construction',
    selected,
    excluded: [],
    argumentRequirements: Object.fromEntries(
      selected.map((entry) => [
        entry.capability.name,
        (entry.descriptor?.inputSchema.required as readonly string[] | undefined) ?? [],
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
        toolNames: selected.map((entry) => entry.capability.name),
        alternatives,
        reason: 'Test capabilities are available.',
      },
    ],
  };
}

function contextNeed(
  intent: NormalizedIntent,
  input: {
    type?: ContextNeed['type'];
    sourceKinds?: readonly ContextSourceKind[];
    sourceRequirement?: ContextNeed['sourceRequirement'];
    capability?: ContextCapability;
    inputs?: Readonly<Record<string, unknown>>;
  } = {},
): ContextNeed {
  const capability = input.capability ?? 'WEB_RETRIEVAL';
  const sourceKinds = input.sourceKinds ?? ['WEB'];
  return {
    id: 'need-1',
    type: input.type ?? 'CURRENT_EXTERNAL_INFORMATION',
    required: true,
    requiredInformation: ['requested evidence'],
    missingInformation: ['requested evidence'],
    reason: 'The requested answer requires retrieved evidence.',
    sourceRequirement: input.sourceRequirement ?? 'external',
    sourceKinds,
    freshnessRequirement: 'CURRENT',
    authorityRequirement: 'AUTHORITATIVE',
    scope: { conversationId: 'conversation-1', taskId: 'task-1', namespaces: ['test'] },
    evidenceRequirement: 'REQUIRED',
    requiredCapability: capability,
    capabilityRequirement: {
      id: 'requirement-1',
      needId: 'need-1',
      capability,
      prerequisiteCapabilities: capability === 'WEB_RETRIEVAL' ? ['WEB_SEARCH'] : [],
      alternativeCapabilities: capability === 'WEB_RETRIEVAL' ? ['WEB_FETCH'] : [],
      sourceKinds,
      readOnly: true,
      requiredInputs: ['query'],
      authorityRequirement: 'AUTHORITATIVE',
      freshnessRequirement: 'CURRENT',
    },
    priority: 'critical',
    status: 'missing',
    inputs: input.inputs ?? { query: intent.normalizedRequest },
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
    id: partial.id ?? 'operation-1',
    requestId: 'request-1',
    needId: 'need-1',
    capability: partial.capability ?? 'WEB_SEARCH',
    phase: partial.phase ?? 'discovery',
    toolName: partial.toolName ?? 'web_search',
    input,
    attemptKey: partial.attemptKey ?? stableHash({ toolName: 'web_search', input }),
    strategy: partial.strategy ?? 'INITIAL',
    iteration: partial.iteration ?? 1,
    status: partial.status ?? 'succeeded',
    executionState: partial.executionState ?? 'SUCCESS',
    resourceState: partial.resourceState ?? 'RETRIEVED_SUCCESSFULLY',
    startedAt: timestamp,
    completedAt: timestamp,
    ...partial,
  };
}

function observation(partial: Partial<ToolObservation> = {}): ToolObservation {
  const source = {
    id: 'source-1',
    name: 'Official AWS result',
    type: 'external' as const,
    sourceKind: 'WEB' as const,
    authority: 0.95,
    retrievedAt: timestamp,
    uri: selectedResultUrl,
  };
  return {
    id: partial.id ?? 'observation-1',
    toolCallId: partial.toolCallId ?? 'operation-1',
    toolName: partial.toolName ?? 'web_search',
    outcome: partial.outcome ?? 'success',
    content: partial.content ?? 'AWS AgentCore official documentation result.',
    facts: partial.facts ?? ['AWS AgentCore official documentation result.'],
    identifiers: [],
    errors: partial.errors ?? [],
    source,
    provenance: {
      id: 'provenance-1',
      source,
      steps: [{ operation: 'retrieved', at: timestamp, component: 'test', inputIds: [] }],
      parentIds: [],
    },
    requiresFollowUp: partial.requiresFollowUp ?? true,
    createdAt: timestamp,
    requestId: 'request-1',
    needIds: ['need-1'],
    capability: partial.capability ?? 'WEB_SEARCH',
    links: partial.links ?? [selectedResultUrl],
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
    authority: 0.95,
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
  captured: {
    searches: SearchInput[];
    fetches: FetchInput[];
  },
  options: { failFirstSearch?: boolean; transformSearchQuery?: boolean } = {},
): [Tool<SearchInput>, Tool<FetchInput>] {
  const baseSearchSchema = z.object({
    query: z.string().max(400),
    maxResults: z.number().optional(),
  });
  const searchSchema = options.transformSearchQuery
    ? baseSearchSchema.transform((input) => ({ ...input, query: input.query.toUpperCase() }))
    : baseSearchSchema;
  const fetchSchema = z.object({ url: z.string().url(), prompt: z.string().max(400).optional() });
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
          return {
            content: 'Invalid input for web_search query.',
            isError: true,
          };
        }
        return {
          content: JSON.stringify({
            results: [
              {
                title: 'What is AWS AgentCore?',
                url: selectedResultUrl,
                snippet: 'Official AWS documentation for AWS AgentCore.',
              },
            ],
          }),
          metadata: { url: selectedResultUrl },
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
            'AWS AgentCore is an official AWS platform for securely building, deploying, and operating AI agents in production.',
          metadata: { url: input.url },
        };
      },
    },
  ];
}

async function executeRuntimePrompt(
  prompt: string,
  options: { failFirstSearch?: boolean } = {},
): Promise<{
  searches: SearchInput[];
  fetches: FetchInput[];
}> {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'AWS AgentCore answer.' },
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
    // Consume the complete Context Intelligence retrieval loop.
  }
  return captured;
}

test('short information need becomes the actual web_search query', () => {
  const intent = resolver.resolve('What is AWS AgentCore?');
  const need = contextNeed(intent);
  const action = plan(intent, need, webCapabilities())[0];

  assert.ok(action);
  assert.equal(action.toolName, 'web_search');
  assert.equal(action.input.query, action.retrievalInput?.retrievalRequest);
  assert.equal(action.input.query, intent.normalizedRequest);
  assert.match(String(action.input.query), /AWS AgentCore/i);
});

test('diagnostic orchestration and report fields never enter the actual web_search query', () => {
  assert.ok(diagnosticPrompt.length > 400);
  const intent = resolver.resolve(diagnosticPrompt);
  const need = contextNeed(intent);
  const action = plan(intent, need, webCapabilities())[0];
  const query = String(action?.input.query ?? '');

  assert.ok(action);
  assert.equal(query, action.retrievalInput?.retrievalRequest);
  assert.equal(query, 'What is AWS AgentCore?');
  assert.notEqual(query, diagnosticPrompt);
  assert.match(query, /AWS AgentCore/i);
  for (const forbidden of [
    'runtime test',
    'runtime validation test',
    'critical',
    'test passes only if',
    'then execute',
    'context need',
    'selected capability',
    'actual tool call',
    'actual input',
    'runtime telemetry',
    'pass / fail',
    'do not modify',
  ]) {
    assert.equal(query.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('semantic freshness, authority, vendor, production, and domain terms are preserved', () => {
  const intent = resolver.resolve(
    'What is the latest official AWS guidance for production generative AI?',
  );
  const action = plan(intent, contextNeed(intent), webCapabilities())[0];
  const query = String(action?.input.query ?? '').toLowerCase();

  for (const required of ['latest', 'official', 'aws', 'production', 'generative ai']) {
    assert.ok(query.includes(required), required);
  }
});

test('a prompt over 400 characters with a short information need produces a bounded action input', () => {
  const intent = resolver.resolve(diagnosticPrompt);
  const action = plan(intent, contextNeed(intent), webCapabilities())[0];
  const query = String(action?.input.query ?? '');

  assert.ok(diagnosticPrompt.length > 400);
  assert.ok(query.length > 0 && query.length <= 400);
  assert.equal(action?.retrievalInput?.capabilityMaximumLength, 400);
  assert.equal(query, action?.retrievalInput?.retrievalRequest);
});

test('a genuinely long compound information need compacts the authoritative request first', () => {
  const request = [
    'Compare the latest official AWS production guidance for generative AI agent security',
    'AWS production guidance for generative AI agent memory',
    'AWS production guidance for generative AI agent observability',
    'AWS production guidance for generative AI agent identity and access management',
  ].join('; and ');
  const intent = resolver.resolve(request);
  const capabilities = webCapabilities();
  const search = capabilities[0]!;
  const queryDefinition = (
    search.descriptor!.inputSchema.properties as Record<string, Record<string, unknown>>
  ).query!;
  queryDefinition.maxLength = 120;
  const action = plan(intent, contextNeed(intent), capabilities)[0];

  assert.ok(action);
  assert.equal(action.retrievalInput?.construction, 'semantic_compaction');
  assert.equal(action.retrievalInput?.informationNeed, intent.normalizedRequest);
  assert.equal(action.input.query, action.retrievalInput?.retrievalRequest);
  assert.ok(String(action.input.query).length <= 120);
  assert.notEqual(action.input.query, request);
});

test('AgentSession executes clean web_search and search-result-derived web_fetch inputs', async () => {
  const normalizedRetrievalRequest = resolver.resolve(diagnosticPrompt).normalizedRequest;
  const captured = await executeRuntimePrompt(diagnosticPrompt);

  assert.equal(normalizedRetrievalRequest, 'What is AWS AgentCore?');
  assert.ok(captured.searches.length >= 1, 'web_search must execute');
  const actualSearch = captured.searches[0]!;
  assert.equal(actualSearch.query, normalizedRetrievalRequest);
  assert.equal(actualSearch.query.toLowerCase().includes('runtime test'), false);

  assert.ok(captured.fetches.length >= 1, 'web_fetch must execute after search');
  const actualFetch = captured.fetches[0]!;
  assert.equal(actualFetch.url, selectedResultUrl);
  assert.equal(actualFetch.prompt, normalizedRetrievalRequest);
  assert.equal((actualFetch.prompt ?? '').toLowerCase().includes('actual tool call'), false);
});

for (const scenario of [
  {
    name: 'latest official information request',
    informationNeed: 'Find the latest official AWS information about AgentCore.',
  },
  {
    name: 'comparison request',
    informationNeed: 'Compare AWS AgentCore Runtime and Gateway.',
  },
]) {
  test(`long diagnostic ${scenario.name} reaches tools unchanged`, async () => {
    const prompt = diagnosticPromptFor(scenario.informationNeed);
    const intent = resolver.resolve(prompt);
    const action = plan(intent, contextNeed(intent), webCapabilities())[0];

    assert.ok(prompt.split(/\r?\n/).length > 30);
    assert.equal(intent.normalizedRequest, scenario.informationNeed);
    assert.ok(action);
    assert.equal(action.input.query, scenario.informationNeed);
    assert.equal(action.input.query, action.retrievalInput?.retrievalRequest);

    const captured = await executeRuntimePrompt(prompt);
    assert.equal(captured.searches[0]?.query, scenario.informationNeed);
    assert.equal(captured.fetches[0]?.url, selectedResultUrl);
    assert.equal(captured.fetches[0]?.prompt, scenario.informationNeed);
  });
}

test('non-retrieval task keywords do not trigger a retrieval capability', async () => {
  const prompt =
    'Update the local search test report so CRITICAL failures are grouped by component. Keep the report wording concise.';
  const intent = resolver.resolve(prompt);
  const captured = await executeRuntimePrompt(prompt);

  assert.equal(intent.operation, 'update');
  assert.equal(intent.normalizedRequest, prompt);
  assert.deepEqual(captured.searches, []);
  assert.deepEqual(captured.fetches, []);
});

test('MCP retrieval maps the normalized information need through its prompt contract', () => {
  const intent = resolver.resolve(diagnosticPrompt);
  const need = contextNeed(intent, {
    type: 'MCP_DOMAIN_INFORMATION',
    sourceKinds: ['MCP'],
    sourceRequirement: 'mcp',
    capability: 'MCP_RETRIEVAL',
    inputs: { query: intent.normalizedRequest },
  });
  const mcp = selectedCapability(
    'mcp__knowledge__search',
    'MCP_RETRIEVAL',
    { prompt: { type: 'string', maxLength: 400 } },
    ['prompt'],
    { query: 'prompt' },
  );
  const action = plan(intent, need, [mcp])[0];

  assert.ok(action);
  assert.match(String(action.input.prompt), /AWS AgentCore/i);
  assert.notEqual(action.input.prompt, diagnosticPrompt);
  assert.equal(action.input.prompt, action.retrievalInput?.retrievalRequest);
});

test('artifact retrieval preserves the exact artifact identifier', () => {
  const intent = resolver.resolve('Read artifact://artifact-123 and summarize it.');
  const need = contextNeed(intent, {
    type: 'ARTIFACT_INFORMATION',
    sourceKinds: ['ARTIFACT'],
    sourceRequirement: 'artifact',
    capability: 'ARTIFACT_READ',
    inputs: {
      reference: 'artifact://artifact-123',
      referenceKind: 'artifact',
      referenceOrigin: 'explicit_user_reference',
      artifactId: 'artifact-123',
    },
  });
  const artifact = selectedCapability(
    'artifact_read',
    'ARTIFACT_READ',
    { artifactId: { type: 'string' }, referenceOrigin: { type: 'string' } },
    ['artifactId'],
  );
  const action = plan(intent, need, [artifact])[0];

  assert.ok(action);
  assert.equal(action.input.artifactId, 'artifact-123');
  assert.equal('query' in action.input, false);
});

test('file retrieval preserves the exact user-supplied path', () => {
  const path = 'src/context-intelligence/runtime-retrieval.ts';
  const intent = resolver.resolve(`Read ${path}.`);
  const need = contextNeed(intent, {
    type: 'FILE_INFORMATION',
    sourceKinds: ['FILE'],
    sourceRequirement: 'workspace',
    capability: 'FILE_READ',
    inputs: {
      reference: path,
      referenceKind: 'path',
      referenceOrigin: 'explicit_user_reference',
      path,
    },
  });
  const file = selectedCapability('read_file', 'FILE_READ', { path: { type: 'string' } }, ['path']);
  const action = plan(intent, need, [file])[0];

  assert.ok(action);
  assert.equal(action.input.path, path);
  assert.equal('query' in action.input, false);
});

test('adaptive retrieval constructs attempt 2 from the normalized need, not the raw prompt', () => {
  const intent = resolver.resolve(diagnosticPrompt);
  const need = contextNeed(intent);
  const initial = plan(intent, need, webCapabilities())[0]!;
  const failedOperation = operation(initial.input, {
    id: initial.id,
    attemptKey: initial.attemptKey,
    status: 'failed',
    executionState: 'FAILED',
    resourceState: 'RETRIEVAL_FAILED',
    failureClassification: 'invalid_input',
    ...(initial.retrievalInput === undefined ? {} : { retrievalInput: initial.retrievalInput }),
  });
  const failedObservation = observation({
    toolCallId: initial.id,
    outcome: 'error',
    content: 'Invalid input for web_search query.',
    facts: [],
    errors: ['Invalid input for web_search query.'],
    links: [],
    failureClassification: 'invalid_input',
  });
  const adaptive = new AdaptiveRetrievalIntelligence(config).evaluate({
    requestId: 'request-1',
    needs: [need],
    operations: [failedOperation],
    observations: [failedObservation],
    evaluatedEvidence: [],
    conflicts: [],
    elapsedMs: 2,
  });
  const second = plan(intent, need, webCapabilities(), {
    operations: [failedOperation],
    observations: [failedObservation],
    adaptive,
  })[0];
  const secondQuery = String(second?.input.query ?? '');

  assert.ok(second);
  assert.equal(second.strategy, 'QUERY_REWRITE');
  assert.notEqual(secondQuery, initial.input.query);
  assert.notEqual(secondQuery, diagnosticPrompt);
  assert.match(secondQuery, /AWS AgentCore/i);
  assert.equal(secondQuery.toLowerCase().includes('runtime telemetry'), false);
  assert.equal(secondQuery, second.retrievalInput?.retrievalRequest);
});

test('provenance distinguishes raw request, information need, actual request, and execution', async () => {
  const captured = {
    searches: [] as SearchInput[],
    fetches: [] as FetchInput[],
  };
  const [search, fetch] = runtimeTools(captured);
  const engine = new ContextIntelligenceEngine({
    config: { query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } } },
  });
  const prepareInput = {
    request: diagnosticPrompt,
    messages: [],
    tools: [search, fetch] as Tool[],
    systemPrompt: '',
    scope: { conversationId: 'conversation-1', taskId: 'task-1', namespaces: ['test'] },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  };
  const first = await engine.prepare(prepareInput);
  const action = first.contract.directive.actions[0];

  assert.ok(action);
  assert.equal(first.contract.rawRequest, diagnosticPrompt);
  assert.match(first.contract.intent.normalizedRequest, /AWS AgentCore/i);
  assert.notEqual(first.contract.intent.normalizedRequest, diagnosticPrompt);
  assert.equal(action.input.query, action.retrievalInput?.retrievalRequest);
  assert.equal(first.contract.runtimeRetrieval[0]?.input.query, action.input.query);

  const parsed = search.inputSchema.parse(action.input);
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
    executionDurationMs: 1,
    actualToolInput: parsed,
  });
  const second = await engine.prepare(prepareInput);
  const observed = second.contract.observations.find((entry) => entry.toolCallId === action.id);
  const traced = observed?.provenance.steps.find(
    (step) => step.details?.normalizedRetrievalRequest !== undefined,
  );

  assert.equal(captured.searches[0]?.query, action.input.query);
  assert.equal(traced?.details?.informationNeed, action.retrievalInput?.informationNeed);
  assert.equal(traced?.details?.normalizedRetrievalRequest, action.input.query);
  assert.equal(traced?.details?.retrievalArgument, 'query');
});

test('a failed runtime retrieval remains failed and produces no evidence', async () => {
  const captured = {
    searches: [] as SearchInput[],
    fetches: [] as FetchInput[],
  };
  const [baseSearch, fetch] = runtimeTools(captured);
  const search: Tool<SearchInput> = {
    ...baseSearch,
    async execute(input) {
      captured.searches.push(structuredClone(input));
      return { content: 'web_search failed', isError: true };
    },
  };
  const engine = new ContextIntelligenceEngine();
  const prepareInput = {
    request: 'What is the current status of AWS AgentCore?',
    messages: [],
    tools: [search, fetch] as Tool[],
    systemPrompt: '',
    scope: { conversationId: 'conversation-1', taskId: 'task-1', namespaces: ['test'] },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  };
  const first = await engine.prepare(prepareInput);
  const action = first.contract.directive.actions[0];
  assert.ok(action);
  const parsed = search.inputSchema.parse(action.input);
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
    executionDurationMs: 1,
    actualToolInput: parsed,
  });
  const second = await engine.prepare(prepareInput);
  const failed = second.contract.runtimeRetrieval.find((entry) => entry.id === action.id);

  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.executionState, 'FAILED');
  assert.equal(second.contract.evidence.length, 0);
});

test('instruction-only input does not fall back to the raw prompt as a retrieval need', () => {
  const prompt = 'Do not modify anything. Report: Runtime telemetry. PASS / FAIL.';
  const intent = resolver.resolve(prompt);

  assert.equal(intent.instructionSegments.informationRequirements.length, 0);
  assert.equal(intent.normalizedRequest, '');
});

test('AgentSession executes a clean changed query after a genuine first-attempt failure', async () => {
  const normalizedRetrievalRequest = resolver.resolve(diagnosticPrompt).normalizedRequest;
  const captured = await executeRuntimePrompt(diagnosticPrompt, { failFirstSearch: true });

  assert.ok(captured.searches.length >= 2, 'the failed first search must trigger another search');
  const first = captured.searches[0]!;
  const second = captured.searches[1]!;

  assert.equal(first.query, normalizedRetrievalRequest);
  assert.notEqual(second.query, first.query);
  assert.match(second.query, /AWS AgentCore/i);
  for (const actual of [first.query, second.query]) {
    assert.equal(actual.toLowerCase().includes('evidence is missing'), false);
    assert.equal(actual.toLowerCase().includes('explain why'), false);
    assert.equal(actual.toLowerCase().includes('runtime telemetry'), false);
    assert.equal(actual.toLowerCase().includes('grounding decision'), false);
  }

  assert.ok(captured.fetches.length >= 1, 'successful adapted search must lead to web_fetch');
  assert.equal(captured.fetches[0]?.url, selectedResultUrl);
  assert.equal(captured.fetches[0]?.prompt, normalizedRetrievalRequest);
});

test('runtime provenance and telemetry preserve every actual adaptive attempt', async () => {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const [search, fetch] = runtimeTools(captured, { failFirstSearch: true });
  const telemetry: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  const engine = new ContextIntelligenceEngine({
    config: { query: { capabilityQueryLengths: { WEB_SEARCH: 400, WEB_FETCH: 400 } } },
    onTelemetry(event) {
      telemetry.push({ event: event.event, data: event.data });
    },
  });
  const prepareInput = {
    request: diagnosticPrompt,
    messages: [],
    tools: [search, fetch] as Tool[],
    systemPrompt: '',
    scope: { conversationId: 'conversation-1', taskId: 'task-1', namespaces: ['test'] },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  };
  let latest = await engine.prepare(prepareInput);

  for (let index = 0; index < 6; index += 1) {
    const action = latest.contract.directive.actions[0];
    if (!action) break;
    const toolContext = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: action.id,
      workingDirectory: '.',
      signal: new AbortController().signal,
      messages: [],
      reportProgress() {},
    };
    if (action.toolName === search.name) {
      const parsed = search.inputSchema.parse(action.input);
      const output = await search.execute(parsed, toolContext);
      await engine.processObservation({
        tool: search,
        toolCallId: action.id,
        output,
        sessionId: 'session-1',
        turnId: 'turn-1',
        executionDurationMs: 1,
        actualToolInput: parsed,
      });
    } else {
      assert.equal(action.toolName, fetch.name);
      const parsed = fetch.inputSchema.parse(action.input);
      const output = await fetch.execute(parsed, toolContext);
      await engine.processObservation({
        tool: fetch,
        toolCallId: action.id,
        output,
        sessionId: 'session-1',
        turnId: 'turn-1',
        executionDurationMs: 1,
        actualToolInput: parsed,
      });
    }
    latest = await engine.prepare(prepareInput);
  }

  assert.equal(latest.contract.directive.actions.length, 0, 'a terminal retrieval decision must stop retrieval');
  const operations = latest.contract.runtimeRetrieval;
  const searchOperations = operations.filter((entry) => entry.capability === 'WEB_SEARCH');
  const fetchOperations = operations.filter((entry) => entry.capability === 'WEB_FETCH');

  assert.equal(searchOperations.length, 2);
  assert.equal(fetchOperations.length, 1);
  assert.deepEqual(searchOperations[0]?.input, captured.searches[0]);
  assert.deepEqual(searchOperations[0]?.actualInput, captured.searches[0]);
  assert.deepEqual(searchOperations[1]?.input, captured.searches[1]);
  assert.deepEqual(searchOperations[1]?.actualInput, captured.searches[1]);
  assert.deepEqual(fetchOperations[0]?.input, captured.fetches[0]);
  assert.deepEqual(fetchOperations[0]?.actualInput, captured.fetches[0]);
  assert.equal(searchOperations[0]?.strategy, 'INITIAL');
  assert.notEqual(searchOperations[1]?.strategy, 'INITIAL');
  assert.equal(searchOperations[1]?.previousStrategy, 'INITIAL');
  assert.ok(searchOperations[1]?.adaptationReason);
  assert.notEqual(searchOperations[1]?.retrievalInput?.retrievalRequest, searchOperations[0]?.retrievalInput?.retrievalRequest);
  assert.equal(searchOperations[0]?.retrievalResult, 'TOOL_FAILURE');
  assert.equal(searchOperations[0]?.contributedEvidence, false);
  assert.equal(fetchOperations[0]?.status, 'succeeded');
  assert.notEqual(fetchOperations[0]?.retrievalResult, undefined);
  assert.notEqual(fetchOperations[0]?.evidenceQuality, undefined);
  assert.equal(typeof fetchOperations[0]?.contributedEvidence, 'boolean');
  assert.ok(fetchOperations[0]?.terminationReason);

  for (const operation of operations) {
    assert.equal(
      operation.input[operation.retrievalInput?.argumentName ?? ''],
      operation.retrievalInput?.retrievalRequest,
    );
    const observed = latest.contract.observations.find(
      (entry) => entry.id === operation.observationId,
    );
    const provenance = observed?.provenance.steps.find(
      (step) => step.details?.normalizedRetrievalRequest !== undefined,
    );
    assert.equal(provenance?.details?.capability, operation.capability);
    assert.equal(provenance?.details?.retrievalStrategy, operation.strategy);
    assert.equal(
      provenance?.details?.normalizedRetrievalRequest,
      operation.retrievalInput?.retrievalRequest,
    );
    assert.equal(provenance?.details?.resultStatus, observed?.outcome);
    assert.deepEqual(provenance?.details?.actualToolInput, operation.actualInput);
  }

  const attemptTelemetry = telemetry.filter(
    (event) => event.event === 'context-intelligence.observation' && event.data.retrieval_attempt_number !== undefined,
  );
  const firstTelemetry = attemptTelemetry.find(
    (event) => event.data.retrieval_attempt_number === 1 && event.data.tool === 'web_search',
  );
  const secondTelemetry = attemptTelemetry.find(
    (event) => event.data.retrieval_attempt_number === 2 && event.data.tool === 'web_search',
  );
  assert.deepEqual(firstTelemetry?.data.actual_tool_input, captured.searches[0]);
  assert.deepEqual(secondTelemetry?.data.actual_tool_input, captured.searches[1]);
  assert.equal(firstTelemetry?.data.retrieval_failure_reason, 'invalid_input');
  assert.notEqual(firstTelemetry?.data.retrieval_request, secondTelemetry?.data.retrieval_request);

  const adaptiveTelemetry = telemetry.filter(
    (event) => event.event === 'context-intelligence.retrieval' && event.data.phase === 'adaptive',
  );
  assert.ok(adaptiveTelemetry.some((event) => event.data.retrieval_attempt_count === 1));
  assert.ok(adaptiveTelemetry.some((event) => event.data.retrieval_attempt_count === 2));
  const terminalTelemetry = adaptiveTelemetry.at(-1)?.data;
  for (const field of [
    'retrieval_attempt_count',
    'retrieval_strategy',
    'retrieval_result',
    'retrieval_budget_remaining',
    'evidence_quality',
    'termination_reason',
  ]) {
    assert.notEqual(terminalTelemetry?.[field], undefined, field);
  }
});

test('AgentSession records schema-normalized input as the actual tool input', async () => {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const telemetry: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  const engine = new ContextIntelligenceEngine({
    onTelemetry(event) {
      telemetry.push({ event: event.event, data: event.data });
    },
  });
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'Project Aurora answer.' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: runtimeTools(captured, { transformSearchQuery: true }),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: engine,
  });

  const request = 'Use current web information to answer:\n\nWhat is AWS AgentCore?';
  for await (const _event of session.run({ prompt: request })) {
    // Consume the complete retrieval loop.
  }

  const normalizedRequest = resolver.resolve(request).normalizedRequest;
  assert.equal(
    captured.searches[0]?.query,
    normalizedRequest.toUpperCase(),
    JSON.stringify({ telemetry, captured }),
  );
  const searchTelemetry = telemetry.find(
    (event) =>
      event.event === 'context-intelligence.observation' && event.data.tool === 'web_search',
  );
  assert.equal(searchTelemetry?.data.retrieval_request, normalizedRequest);
  assert.deepEqual(searchTelemetry?.data.actual_tool_input, captured.searches[0]);
  assert.notEqual(searchTelemetry?.data.actual_tool_input, searchTelemetry?.data.retrieval_request);
});

test('pre-execution validation failure records no actual tool input', async () => {
  const captured = { searches: [] as SearchInput[], fetches: [] as FetchInput[] };
  const [baseSearch, fetch] = runtimeTools(captured);
  const invalidSearch: Tool<SearchInput> = {
    ...baseSearch,
    inputSchema: z.object({
      query: z.string().refine(() => false, 'rejected before execution'),
      maxResults: z.number().optional(),
    }),
  };
  const telemetry: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  const engine = new ContextIntelligenceEngine({
    onTelemetry(event) {
      telemetry.push({ event: event.event, data: event.data });
    },
  });
  const session = createAgentSession({
    provider: new ScriptedModelProvider([]),
    tools: [invalidSearch, fetch],
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: engine,
  });

  for await (const _event of session.run({
    prompt: 'Use current web information to answer:\n\nWhat is AWS AgentCore?',
  })) {
    // Consume validation failures until the existing retrieval budget terminates the loop.
  }

  assert.deepEqual(captured.searches, [], 'tool.execute must not run after schema rejection');
  const rejectedAttempts = telemetry.filter(
    (event) =>
      event.event === 'context-intelligence.observation' && event.data.tool === 'web_search',
  );
  assert.ok(rejectedAttempts.length > 0);
  for (const attempt of rejectedAttempts) {
    assert.equal(attempt.data.actual_tool_input, undefined);
    assert.equal(attempt.data.retrieval_failure_reason, 'invalid_input');
  }
});
