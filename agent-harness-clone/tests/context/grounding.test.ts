import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AllowAllPermissionHandler,
  ContextIntelligenceEngine,
  ScriptedModelProvider,
  contextIntelligenceReport,
  createAgentSession,
  createWebFetchTool,
  createWebSearchTool,
  type AgentEvent,
  type WebSearchProvider,
} from '../../src/index.js';

const request = 'Find the latest official AWS information about AgentCore.';
const resultUrl = 'https://aws.amazon.com/bedrock/agentcore/';
const fixedDate = new Date('2026-09-02T08:00:00.000Z');

function tools(
  evidenceText = 'AWS AgentCore currently provides managed runtime services for agent applications.',
) {
  const provider: WebSearchProvider = {
    name: 'grounding-search',
    async search(input) {
      return {
        requestId: `search:${input.query}`,
        hits: [
          {
            title: 'Latest official AWS AgentCore information',
            url: resultUrl,
            excerpt: 'Current official AWS AgentCore information.',
            score: 0.99,
            publishedDate: '2026-09-01',
          },
        ],
      };
    },
  };
  return [
    createWebSearchTool({ provider, now: () => fixedDate }),
    createWebFetchTool({
      now: () => fixedDate.getTime(),
      fetch: async () =>
        new Response(
          `<html><head><title>Latest official AWS AgentCore information</title></head><body>${evidenceText}</body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    }),
  ] as const;
}

const scope = {
  applicationId: 'grounding-test',
  conversationId: 'conversation-1',
  taskId: 'task-1',
  namespaces: ['test'],
};

test('a planned retrieval remains NOT_EXECUTED and cannot become evidence', async () => {
  const engine = new ContextIntelligenceEngine();
  const { contract } = await engine.prepare({
    request,
    messages: [],
    tools: tools(),
    systemPrompt: '',
    scope,
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  });

  const report = contextIntelligenceReport(contract);
  assert.equal(report.retrieval.attempts.length, 1);
  assert.equal(report.retrieval.attempts[0]?.executionState, 'NOT_EXECUTED');
  assert.equal(report.retrieval.attempts[0]?.actualToolInput, undefined);
  assert.equal(report.retrieval.attempts[0]?.actualToolResult, undefined);
  assert.equal(report.retrieval.attempts[0]?.observation, undefined);
  assert.deepEqual(report.retrieval.attempts[0]?.evidence, []);
  assert.equal(report.trace.provenance.status, 'PARTIAL');
});

test('unsupported final claims fail grounding and are not released as an answer', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        {
          type: 'text_delta',
          delta: 'The lunar surface contains newly discovered tropical forests and oceans.',
        },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: tools(),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: {},
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: request })) events.push(event);

  const reports = events.filter((event) => event.type === 'context.intelligence');
  const finalReportEvent = reports.at(-1);
  assert.ok(finalReportEvent && finalReportEvent.type === 'context.intelligence');
  assert.equal(finalReportEvent.report.grounding.status, 'FAIL');
  assert.equal(finalReportEvent.report.grounding.decision, 'ABSTAIN');
  assert.ok(finalReportEvent.report.grounding.unsupportedClaimIds.length > 0);
  assert.equal(finalReportEvent.report.quality.decision, 'ABSTAIN');
  assert.equal(
    events.some((event) => event.type === 'assistant.text.delta'),
    false,
    'ungrounded model text must remain buffered and undisclosed',
  );
  assert.equal(
    events.some((event) => event.type === 'assistant.message.completed'),
    false,
    'an unsupported answer must not become the completed assistant message',
  );
  const warning = events.find(
    (event) => event.type === 'warning' && event.intervention?.kind === 'context-intelligence',
  );
  assert.ok(warning && warning.type === 'warning');
  assert.equal(warning.intervention?.decision, 'ABSTAIN');
});

test('text accompanying a tool request stays undisclosed until a terminal answer passes', async () => {
  const supportedAnswer =
    'AWS AgentCore currently provides managed runtime services for agent applications.';
  const unsupportedIntermediate = 'The lunar surface contains tropical forests and oceans.';
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: unsupportedIntermediate },
        {
          type: 'tool_call',
          id: 'mixed-search',
          name: 'web_search',
          input: { query: request },
        },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: supportedAnswer },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: tools(),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: {},
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: request })) events.push(event);

  const emittedText = events
    .filter((event) => event.type === 'assistant.text.delta')
    .map((event) => event.delta);
  assert.deepEqual(emittedText, [supportedAnswer]);
  const completedText = events
    .filter((event) => event.type === 'assistant.message.completed')
    .flatMap((event) =>
      event.message.content.filter((block) => block.type === 'text').map((block) => block.text),
    );
  assert.equal(completedText.includes(unsupportedIntermediate), false);
  const finalReportEvent = events.filter((event) => event.type === 'context.intelligence').at(-1);
  assert.ok(finalReportEvent && finalReportEvent.type === 'context.intelligence');
  assert.equal(finalReportEvent.report.grounding.status, 'PASS');
});

test('contradictions and material mismatches fail grounding before release', async (t) => {
  const cases = [
    {
      name: 'negated predicate',
      evidence: 'AWS AgentCore currently provides managed runtime services for agent applications.',
      answer:
        'AWS AgentCore currently does not provide managed runtime services for agent applications.',
    },
    {
      name: 'changed version',
      evidence: 'AWS AgentCore runtime version is 41 for managed agent applications.',
      answer: 'AWS AgentCore runtime version is 42 for managed agent applications.',
    },
    {
      name: 'changed date',
      evidence: 'AWS released AgentCore on September 1, 2026 for managed agent applications.',
      answer: 'AWS released AgentCore on September 2, 2026 for managed agent applications.',
    },
    {
      name: 'lacking predicate variant',
      evidence: 'AWS AgentCore currently provides managed runtime services for agent applications.',
      answer: 'AWS AgentCore currently lacks managed runtime services for agent applications.',
    },
    {
      name: 'prefixed version variant',
      evidence: 'AWS AgentCore managed runtime v41 is available for agent applications.',
      answer: 'AWS AgentCore managed runtime v42 is available for agent applications.',
    },
    {
      name: 'lowercase swapped entity variant',
      evidence: 'AWS AgentCore currently provides managed runtime services for agent applications.',
      answer: 'azure AgentCore currently provides managed runtime services for agent applications.',
    },
    {
      name: 'short unsupported trailing claim',
      evidence: 'AWS AgentCore currently provides managed runtime services for agent applications.',
      answer:
        'AWS AgentCore currently provides managed runtime services for agent applications. Moon is cheese.',
    },
    {
      name: 'reversed relation',
      evidence: 'AWS acquired Azure.',
      answer: 'Azure acquired AWS.',
    },
    {
      name: 'swapped entity',
      evidence: 'AWS AgentCore currently provides managed runtime services for agent applications.',
      answer: 'Azure AgentCore currently provides managed runtime services for agent applications.',
    },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const session = createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: scenario.answer },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
        tools: tools(scenario.evidence),
        permissionHandler: new AllowAllPermissionHandler(),
        contextIntelligence: {},
      });
      const events: AgentEvent[] = [];
      for await (const event of session.run({ prompt: request })) events.push(event);

      const finalReportEvent = events
        .filter((event) => event.type === 'context.intelligence')
        .at(-1);
      assert.ok(finalReportEvent && finalReportEvent.type === 'context.intelligence');
      assert.equal(finalReportEvent.report.grounding.status, 'FAIL');
      assert.equal(finalReportEvent.report.grounding.decision, 'ABSTAIN');
      assert.equal(
        events.some((event) => event.type === 'assistant.text.delta'),
        false,
        'contradicted model text must remain buffered and undisclosed',
      );
    });
  }
});

test('claim analysis overflow fails closed before unsupported trailing text can be released', async () => {
  const supportedClaims = Array.from(
    { length: 100 },
    (_, index) =>
      `AWS AgentCore managed runtime fact ${index + 1} is confirmed for agent applications.`,
  );
  const unsupportedClaim =
    'The lunar surface contains newly discovered tropical forests and oceans.';
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: [...supportedClaims, unsupportedClaim].join(' ') },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: tools(supportedClaims.join(' ')),
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: {},
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: request })) events.push(event);

  const finalReportEvent = events.filter((event) => event.type === 'context.intelligence').at(-1);
  assert.ok(finalReportEvent && finalReportEvent.type === 'context.intelligence');
  assert.equal(finalReportEvent.report.grounding.status, 'FAIL');
  assert.equal(finalReportEvent.report.grounding.decision, 'ABSTAIN');
  assert.equal(finalReportEvent.report.grounding.claimCount, 100);
  assert.equal(finalReportEvent.report.grounding.claimsTruncated, true);
  assert.ok(
    finalReportEvent.report.grounding.reasonCodes.includes('grounding_claim_limit_exceeded'),
  );
  assert.equal(
    events.some((event) => event.type === 'assistant.text.delta'),
    false,
    'text beyond the grounding claim limit must never be released unchecked',
  );
});

test('an identical transient retry is executed but not reported as a meaningful strategy change', async () => {
  const [baseSearch, fetch] = tools();
  let calls = 0;
  const flakySearch: typeof baseSearch = {
    ...baseSearch,
    async execute(input, context) {
      calls += 1;
      if (calls === 1) throw new Error('Network connection failed before a result was returned.');
      return baseSearch.execute(input, context);
    },
  };
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        {
          type: 'text_delta',
          delta:
            'AWS AgentCore currently provides managed runtime services for agent applications.',
        },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [flakySearch, fetch],
    permissionHandler: new AllowAllPermissionHandler(),
    contextIntelligence: {},
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: request })) events.push(event);

  const finalReportEvent = events.filter((event) => event.type === 'context.intelligence').at(-1);
  assert.ok(finalReportEvent && finalReportEvent.type === 'context.intelligence');
  assert.equal(finalReportEvent.report.grounding.status, 'PASS');
  assert.equal(
    events.some((event) => event.type === 'assistant.text.delta'),
    true,
    'an answer supported by successful runtime evidence must be released',
  );
  const [failed, retry, fetchAttempt] = finalReportEvent.report.retrieval.attempts;
  assert.equal(calls, 2);
  assert.equal(failed?.executionState, 'FAILED');
  assert.equal(retry?.strategy, 'TRANSIENT_RETRY');
  assert.equal(retry?.executionState, 'SUCCESS');
  assert.deepEqual(retry?.actualToolInput, failed?.actualToolInput);
  assert.equal(retry?.strategyChange?.meaningful, false);
  assert.match(
    retry?.strategyChange?.differences.join(' ') ?? '',
    /not counted as a meaningful adaptive change/i,
  );
  assert.equal(fetchAttempt?.strategy, 'ADDITIONAL_EVIDENCE');
  assert.equal(fetchAttempt?.strategyChange?.meaningful, true);
});
