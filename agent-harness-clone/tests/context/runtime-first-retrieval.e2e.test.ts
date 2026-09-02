import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AllowAllPermissionHandler,
  ContextIntelligenceEngine,
  ScriptedModelProvider,
  createAgentSession,
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  type ContextIntelligenceTelemetryEvent,
  type Tool,
  type ToolExecutionResult,
  type WebFetchInput,
  type WebSearchInput,
  type WebSearchProvider,
} from '../../src/index.js';

const informationNeed =
  'What are the current AWS recommendations for building production generative AI applications?';

const acceptancePromptParts = [
  'P1 BLOCKER \u2014 DO NOT MARK PASS WITHOUT PROVING A REAL FIRST RETRIEVAL',
  `The latest Agent Console runtime report is NOT an acceptable P1 pass.`,
  `\nThe runtime report claims:\n\nFirst Retrieval:\nweb_search(query="AWS recommendations building production generative AI applications 2025")\n\nBut the actual execution reported:\n\n"Retrieval capabilities may execute only from a normalized Context Intelligence retrieval plan."\n\nThen it adapted by using existing Context Intelligence evidence + web_fetch.\n\nThis does NOT prove:\nREQUEST\n\\u2192 clean normalized retrieval request\n\\u2192 actual FIRST web_search invocation\n\\u2192 actual tool result\n\\u2192 evidence evaluation\n\\u2192 insufficiency classification\n\\u2192 adaptive retrieval\n\\u2192 second meaningfully different retrieval.\n\nDo NOT modify Agent Console, AgentCore, MCP servers, or external tools.\n\nFix/verify ONLY the Context Intelligence runtime execution boundary.`,
  `\nRequirements:\n\n1. Trace the production runtime from:\n   user request\n   \u2192 context need extraction\n   \u2192 normalized retrieval request\n   \u2192 retrieval plan\n   \u2192 capability selection\n   \u2192 actual tool invocation\n   \u2192 observation\n   \u2192 evidence evaluation\n   \u2192 adaptive retrieval.\n\n2. There must be ONE authoritative normalized retrieval request.\n\n3. The actual first web_search invocation must receive the normalized retrieval query.\n\nFor this test:\n\nActual information need:\n"${informationNeed}"\n\nAcceptable first query examples:\n"${informationNeed}"\n"current AWS recommendations production generative AI applications"\n"official AWS recommendations production generative AI applications"`,
  `\nThe query MUST NOT contain:\n\n- validate Context Intelligence\n- inspect retrieval\n- report tool calls\n- report evidence count\n- report grounding\n- report telemetry\n- determine whether retrieval is sufficient\n- report PASS or FAIL\n- show the actual tool input\n- report adaptation\n- final decision\n\n4. CRITICAL:\n   Do not allow the runtime's evaluation/reporting instructions to become the retrieval request.\n\n5. Do not fake or reconstruct the first tool input from telemetry after the fact.\n\nTelemetry must capture the EXACT arguments actually passed to the tool at invocation time.\n\n6. If the first web_search succeeds:\n\n   - record exact query\n   - record exact result\n   - evaluate relevance, authority, freshness, completeness.\n\n7. If first retrieval is insufficient:\n   classify the actual insufficiency.\n   Then construct Attempt 2 from the identified evidence gap.\n\nAttempt 2 must:\n\n- be meaningfully different\n- remain based on the original information need\n- address the identified evidence gap\n- contain no test/report/control instructions\n- not be a blind retry.\n\n8. If first retrieval is sufficient:\n   adaptation must be NOT TRIGGERED.\n   Do not force adaptive retrieval.\n\n9. If web_fetch is used:\n\n   - URL must come from an actual search result\n   - fetch prompt must be derived from the actual information need\n   - fetch prompt must not contain test/report instructions.`,
  `\n10. Do not count a failed/blocked retrieval-plan validation as a successful retrieval attempt.\n\n11. Do not use pre-existing Context Intelligence evidence as proof that the current first retrieval succeeded.\n\n12. Add/strengthen regression tests that inspect ACTUAL tool arguments at invocation time, not merely the normalized internal object.\n\n13. Add an E2E regression test covering:\n    full test prompt\n    \u2192 information need extraction\n    \u2192 normalized request\n    \u2192 first web_search\n    \u2192 actual tool argument assertion.\n\n14. The test must fail if the first web_search query becomes the test/reporting prompt.\n\n15. Do not hardcode AWS phrases or the specific test-control phrases.\n    The solution must be generic semantic separation.\n\n16. Run:\n\n- typecheck\n- build\n- focused Context Intelligence tests\n- full relevant test suite\n- runtime E2E acceptance test.\n\nFINAL REPORT MUST DISTINGUISH:\n\nA. normalized query constructed internally\nB. actual first tool arguments\nC. actual first tool result\nD. actual second tool arguments, if any.\n\nDo not mark P1 PASS unless A, B, and C are independently proven.\n\nMost important:\nTHE ACTUAL FIRST TOOL INVOCATION IS THE ACCEPTANCE AUTHORITY.`,
];
const fullAcceptancePrompt = acceptancePromptParts
  .join('\n')
  .replaceAll('\\u2192', String.fromCharCode(0x2192))
  .trim();

const resultUrl =
  'https://aws.amazon.com/blogs/machine-learning/production-generative-ai-guidance/';
const fixedDate = new Date('2026-09-02T06:00:00.000Z');

test('full P1 prompt reaches the real web_search execution boundary with only the information need', async () => {
  const telemetry: ContextIntelligenceTelemetryEvent[] = [];
  const providerQueries: string[] = [];
  const searchInputs: WebSearchInput[] = [];
  const searchResults: ToolExecutionResult[] = [];
  const fetchInputs: WebFetchInput[] = [];

  const provider: WebSearchProvider = {
    name: 'runtime-e2e-search-provider',
    async search(request) {
      providerQueries.push(request.query);
      return {
        requestId: 'search-request-1',
        hits: [
          {
            title: 'Production generative AI guidance on AWS',
            url: resultUrl,
            excerpt:
              'Official AWS source candidate covering current production generative AI guidance.',
            score: 0.99,
            publishedDate: '2026-08-20',
          },
        ],
      };
    },
  };
  const baseSearch = createWebSearchTool({ provider, now: () => fixedDate });
  const search: Tool<WebSearchInput> = {
    ...baseSearch,
    async execute(input, context) {
      searchInputs.push(structuredClone(input));
      const result = await baseSearch.execute(input, context);
      searchResults.push(structuredClone(result));
      return result;
    },
  };
  const baseFetch = createWebFetchTool({
    now: () => fixedDate.getTime(),
    fetch: async () =>
      new Response(
        '<html><head><title>AWS production generative AI guidance</title></head>' +
          '<body><h1>Current AWS recommendations for production generative AI applications</h1>' +
          '<p>AWS recommends governed data, security controls, observability, evaluation, ' +
          'resilience, and cost controls when building production generative AI applications.</p>' +
          '</body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  });
  const fetch: Tool<WebFetchInput> = {
    ...baseFetch,
    async execute(input, context) {
      fetchInputs.push(structuredClone(input));
      return baseFetch.execute(input, context);
    },
  };
  const engine = new ContextIntelligenceEngine({
    onTelemetry(event) {
      telemetry.push(structuredClone(event));
    },
  });
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'Grounded AWS recommendations.' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [search, fetch],
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: engine,
  });

  for await (const _event of session.run({ prompt: fullAcceptancePrompt })) {
    // Consume the complete production AgentSession retrieval loop.
  }

  const queryEvent = telemetry.find((event) => event.event === 'context-intelligence.query');
  assert.equal(queryEvent?.data.normalized_retrieval_request, informationNeed);

  assert.equal(searchInputs.length, 1, 'one real first web_search invocation must occur');
  assert.deepEqual(searchInputs[0], { query: informationNeed, maxResults: 5 });
  assert.deepEqual(providerQueries, [informationNeed]);
  assert.notEqual(searchInputs[0]?.query, fullAcceptancePrompt);

  const invocations = telemetry.filter(
    (event) => event.event === 'context-intelligence.invocation',
  );
  assert.equal(invocations[0]?.data.tool, 'web_search');
  assert.equal(invocations[0]?.data.retrieval_request, informationNeed);
  assert.deepEqual(invocations[0]?.data.actual_tool_input, searchInputs[0]);

  assert.ok(searchResults[0], 'the first web_search must return an actual result');
  const firstObservation = telemetry.find(
    (event) =>
      event.event === 'context-intelligence.observation' && event.data.tool === 'web_search',
  );
  assert.deepEqual(firstObservation?.data.actual_tool_result, searchResults[0]);

  const evaluatedAttempts = telemetry
    .flatMap((event) =>
      Array.isArray(event.data.attempt_evaluations) ? event.data.attempt_evaluations : [],
    )
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  const firstEvaluation = evaluatedAttempts.find(
    (entry) => entry.attempt_number === 1 && entry.tool === 'web_search' && entry.outcome,
  );
  assert.equal(firstEvaluation?.outcome, 'INSUFFICIENT_EVIDENCE');
  const evidenceQuality = firstEvaluation?.evidence_quality as Record<string, unknown> | undefined;
  for (const field of ['relevance', 'authority', 'freshness', 'completeness']) {
    assert.equal(typeof evidenceQuality?.[field], 'number', field);
  }

  assert.equal(fetchInputs.length, 1, 'the discovery gap must trigger one source fetch');
  assert.equal(fetchInputs[0]?.url, resultUrl);
  assert.equal(fetchInputs[0]?.prompt, informationNeed);
  assert.equal(invocations[1]?.data.tool, 'web_fetch');
  assert.deepEqual(invocations[1]?.data.actual_tool_input, fetchInputs[0]);
  assert.equal(invocations[1]?.data.retrieval_strategy, 'ADDITIONAL_EVIDENCE');
  assert.match(String(invocations[1]?.data.adaptation_reason), /complementary evidence/i);

  const terminal = telemetry
    .filter(
      (event) =>
        event.event === 'context-intelligence.retrieval' &&
        event.data.phase === 'adaptive' &&
        event.data.termination_reason !== undefined,
    )
    .at(-1);
  assert.equal(terminal?.data.termination_reason, 'SUFFICIENT_EVIDENCE');
});

test(
  'live provider records the exact first web_search invocation and returned result',
  { skip: process.env.CONTEXT_LIVE_ACCEPTANCE !== '1', timeout: 90_000 },
  async () => {
    const telemetry: ContextIntelligenceTelemetryEvent[] = [];
    const actualInputs: unknown[] = [];
    const actualResults: ToolExecutionResult[] = [];
    const tools = createWebTools({
      search: { maxExcerptChars: 500, maxTotalChars: 1_500 },
    }).map((tool): Tool => {
      if (tool.name !== 'web_search') return tool;
      return {
        ...tool,
        async execute(input, context) {
          actualInputs.push(structuredClone(input));
          const result = await tool.execute(input, context);
          actualResults.push(structuredClone(result));
          return result;
        },
      };
    });
    assert.ok(
      tools.some((tool) => tool.name === 'web_search'),
      'live web_search must be configured',
    );
    const engine = new ContextIntelligenceEngine({
      onTelemetry(event) {
        telemetry.push(structuredClone(event));
      },
    });
    const session = createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'Grounded live acceptance response.' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      tools,
      permissionHandler: new AllowAllPermissionHandler(),
      contextIntelligence: engine,
    });

    for await (const _event of session.run({ prompt: fullAcceptancePrompt })) {
      // Consume the real provider-backed runtime retrieval loop.
    }

    assert.ok(actualInputs[0], 'the live web_search execution boundary must be reached');
    assert.deepEqual(actualInputs[0], { query: informationNeed, maxResults: 5 });
    assert.ok(actualResults[0], 'the live provider must return a real first result');
    const invocation = telemetry.find(
      (event) =>
        event.event === 'context-intelligence.invocation' && event.data.tool === 'web_search',
    );
    const observation = telemetry.find(
      (event) =>
        event.event === 'context-intelligence.observation' && event.data.tool === 'web_search',
    );
    assert.deepEqual(invocation?.data.actual_tool_input, actualInputs[0]);
    assert.deepEqual(observation?.data.actual_tool_result, actualResults[0]);
    if (process.env.CONTEXT_LIVE_ACCEPTANCE_REPORT === '1') {
      const normalized = telemetry.find((event) => event.event === 'context-intelligence.query');
      const invocations = telemetry.filter(
        (event) => event.event === 'context-intelligence.invocation',
      );
      const evaluations = telemetry
        .flatMap((event) =>
          Array.isArray(event.data.attempt_evaluations) ? event.data.attempt_evaluations : [],
        )
        .filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
        );
      console.log(
        `LIVE_CONTEXT_RETRIEVAL_PROOF ${JSON.stringify({
          normalizedQuery: normalized?.data.normalized_retrieval_request,
          firstToolArguments: invocation?.data.actual_tool_input,
          firstToolResult: observation?.data.actual_tool_result,
          firstEvaluation: evaluations.find(
            (entry) => entry.attempt_number === 1 && entry.tool === 'web_search' && entry.outcome,
          ),
          secondToolArguments: invocations[1]?.data.actual_tool_input,
        })}`,
      );
    }
  },
);
