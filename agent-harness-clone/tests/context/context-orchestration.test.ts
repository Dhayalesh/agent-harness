/**
 * The context orchestration layer, end to end.
 *
 * `dynamic-compaction.test.ts` covers the budget arithmetic and `context-pressure.test.ts`
 * covers the threshold ladder. This file covers the layer above them: whether the
 * right *information* survives, whether the cheap mechanisms run before the expensive
 * ones, and whether a user who configured nothing but a percentage gets all of it.
 *
 *   1     a small conversation is not processed at all
 *   2-3   the warning and aggressive tiers do what they say
 *   4     compaction lands at the configured percentage
 *   5     a huge tool result is trimmed before anything is summarised
 *   6-9   decisions, constraints, superseded choices, live errors
 *   10-11 irrelevant history goes, relevant history stays
 *   12    tool_call/tool_result adjacency, on every path
 *   13    a summariser that throws falls back deterministically
 *   14    a provider that rejects the context is retried once
 *   15    a verification failure restores what was lost
 *   16-18 128 K, 256 K and 1 M models
 *   19    every threshold from 1 to 99
 *   20    a manual compaction on a fresh chat does no harm
 *   21    the canonical history is never mutated
 *   25    an agent configures nothing but `compactionThresholdPercent`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentLimitsSchema,
  classifyPressure,
  contextDecisionOf,
  ContextOrchestrator,
  contextPolicyFromPercent,
  createAgentSession,
  DEFAULT_CONTEXT_POLICY,
  deriveContextBudget,
  deriveContextState,
  estimateMessagesTokens,
  manageToolResults,
  renderContextState,
  ScriptedModelProvider,
  scoreMessageImportance,
  selectContext,
  verifyContext,
  DefaultTokenEstimator,
  type AgentEvent,
  type AgentMessage,
  type CompactionSummarizer,
  type ContextManager,
  type ModelContextCapabilities,
  type PreparedContext,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAPS: ModelContextCapabilities = { contextWindow: 200_000, maxOutputTokens: 8_192 };

function budgetOf(capabilities: ModelContextCapabilities = CAPS): number {
  return deriveContextBudget({ capabilities, policy: DEFAULT_CONTEXT_POLICY }).effectiveInputBudget;
}

let counter = 0;
function msg(role: 'user' | 'assistant', text: string, id = `m${(counter += 1)}`): AgentMessage {
  return { id, role, createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text }] };
}

function toolCall(id: string, name = 'read_file', input: unknown = {}): AgentMessage {
  return {
    id: `c-${id}`,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: [{ type: 'tool_call', id: `call-${id}`, name, input }],
  };
}

function toolResult(id: string, content: string, isError = false): AgentMessage {
  return {
    id: `r-${id}`,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: [{ type: 'tool_result', toolCallId: `call-${id}`, content, isError }],
  };
}

/** Filler of roughly the requested token size, calibrated against the estimator. */
function filler(targetTokens: number, word = 'lorem'): AgentMessage[] {
  const body = `${word} `.repeat(80);
  const unit = estimateMessagesTokens([msg('user', body, 'probe')]);
  const count = Math.max(2, Math.round(targetTokens / unit));
  return Array.from({ length: count }, (_, index) =>
    msg(index % 2 === 0 ? 'user' : 'assistant', `${body} entry ${index}`),
  );
}

function textOf(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) =>
      message.content.map((block) =>
        block.type === 'text'
          ? block.text
          : block.type === 'tool_result'
            ? block.content
            : block.type === 'tool_call'
              ? block.name
              : '',
      ),
    )
    .join('\n');
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function decisionOf(prepared: PreparedContext) {
  const decision = contextDecisionOf(prepared);
  assert.ok(decision, 'the orchestrator must report a decision');
  return decision;
}

/**
 * A conversation with real state in it: one stated constraint, one live decision, one
 * unresolved error, one pending item, and as much filler as asked for.
 */
function workConversation(fillerTokens: number): AgentMessage[] {
  return [
    msg(
      'user',
      'Migrate the billing service to Postgres. You must never log customer card numbers, and only use the existing connection pool.',
      'goal',
    ),
    msg(
      'assistant',
      "I'll use the pgx driver for the billing migration and keep the existing connection pool.",
      'decision',
    ),
    ...filler(fillerTokens),
    toolCall('probe', 'read_file', { path: 'billing/service.go' }),
    toolResult('probe', 'package billing\n\nfunc Charge() {}\n'),
    toolCall('boom', 'bash', { command: 'go build ./...' }),
    toolResult('boom', 'billing/service.go:41: undefined reference to pgxpool.Connect', true),
    msg('assistant', 'Next step: still need to add the retry wrapper around Charge.', 'pending'),
    msg('user', 'Carry on with the retry wrapper.', 'ask'),
  ];
}

// ---------------------------------------------------------------------------
// 1. A small conversation is not processed at all
// ---------------------------------------------------------------------------
test('a small conversation is returned untouched, with no analysis performed', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = [
    msg('user', 'You must always run the tests before committing.', 's1'),
    msg('assistant', "I'll run the suite first.", 's2'),
  ];

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  // Reference identity is the contract for "nothing happened".
  assert.equal(result.messages, messages);
  assert.equal(result.compacted, false);
  const decision = decisionOf(result);
  assert.equal(decision.action, 'none');
  assert.equal(decision.pressure, 'nominal');
  // The state analysis is skipped below the warning line, which is what "no
  // unnecessary processing" means: there is a stated constraint in this conversation
  // and the layer deliberately did not go looking for it.
  assert.equal(decision.state.constraints, 0);
  assert.equal(decision.trimmedToolResults, 0);
  assert.equal(decision.verificationPassed, true);
});

// ---------------------------------------------------------------------------
// 2. The warning tier observes without acting
// ---------------------------------------------------------------------------
test('at the warning threshold the context is analysed but not changed', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = workConversation(Math.floor(budgetOf() * 0.72));

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  assert.equal(result.messages, messages);
  assert.equal(result.compacted, false);
  const decision = decisionOf(result);
  assert.equal(decision.action, 'none');
  assert.equal(decision.pressure, 'warning');
  // Analysed, though: this is where the console's explanation comes from.
  assert.ok(decision.state.constraints >= 1, 'the stated constraint should be recognised');
  assert.ok(decision.state.goal, 'the current goal should be recognised');
});

// ---------------------------------------------------------------------------
// 3. The aggressive tier acts, cheapest mechanism first
// ---------------------------------------------------------------------------
test('at the aggressive threshold oversized tool output is controlled before anything else', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = [
    msg('user', 'Read the build log and tell me what failed.', 'ask'),
    toolCall('log', 'bash', { command: 'cat build.log' }),
    // On its own past the compaction line.
    toolResult('log', 'y'.repeat(1_200_000)),
  ];
  assert.ok(estimateMessagesTokens(messages) > budgetOf());

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  const decision = decisionOf(result);
  assert.equal(decision.action, 'tool-result-trimming');
  assert.equal(result.compacted, false, 'the conversation itself must survive intact');
  assert.equal(result.messages.length, 3);
  assert.ok(decision.trimmedToolResults >= 1);
  assert.ok(result.estimatedTokens <= budgetOf());
  assert.match(textOf(result.messages), /Read the build log/);
});

// ---------------------------------------------------------------------------
// 4. Compaction lands at the configured percentage
// ---------------------------------------------------------------------------
test('the configured percentage is the line the prepared context comes in under', async () => {
  for (const percent of [30, 50, 80]) {
    const orchestrator = new ContextOrchestrator({ policy: contextPolicyFromPercent(percent) });
    const messages = workConversation(Math.floor(budgetOf() * 0.95));

    const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

    const ceiling = budgetOf() * (percent / 100);
    assert.ok(
      result.estimatedTokens <= ceiling,
      `at ${percent}%: ${result.estimatedTokens} tokens exceeds its own ${Math.floor(ceiling)}-token line`,
    );
    assert.notEqual(decisionOf(result).action, 'none');
  }
});

// ---------------------------------------------------------------------------
// 5. A huge tool result is trimmed before compaction is considered
// ---------------------------------------------------------------------------
test('a runaway tool result is trimmed rather than summarising the conversation away', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = [
    ...workConversation(Math.floor(budgetOf() * 0.3)),
    toolCall('huge', 'read_file', { path: 'package-lock.json' }),
    toolResult('huge', 'z'.repeat(2_000_000)),
    msg('user', 'What version of pgx is pinned?', 'follow-up'),
  ];

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  const decision = decisionOf(result);
  assert.ok(decision.trimmedToolResults >= 1);
  assert.equal(decision.compactedMessageCount, 0, 'nothing needed to be summarised');
  assert.ok(result.estimatedTokens <= budgetOf());
  // Every message is still there; only one block got shorter.
  assert.equal(result.messages.length, messages.length);
  assert.match(textOf(result.messages), /characters of this tool result were removed/);
});

test('tool results are classified, and an error keeps more room than a success', () => {
  const messages = [
    msg('user', 'build it', 'u'),
    toolCall('ok', 'bash', { command: 'go build' }),
    toolResult('ok', 'a'.repeat(200_000)),
    toolCall('bad', 'bash', { command: 'go test' }),
    toolResult('bad', `FAIL billing ${'b'.repeat(200_000)}`, true),
  ];

  const managed = manageToolResults(messages, {
    effectiveInputBudget: 20_000,
    pressure: 'critical',
  });

  const byClass = new Map(managed.decisions.map((entry) => [entry.classification, entry]));
  assert.ok(byClass.get('error'));
  assert.ok(byClass.get('important'));
  assert.ok(
    byClass.get('error')!.keptChars > byClass.get('important')!.keptChars,
    'an error must not be cut harder than a successful result',
  );
});

test('an identical earlier tool result is replaced by a pointer, not a second copy', () => {
  const listing = 'total 48\n'.repeat(400);
  const messages = [
    msg('user', 'list it twice', 'u'),
    toolCall('one', 'bash', { command: 'ls -la' }),
    toolResult('one', listing),
    toolCall('two', 'bash', { command: 'ls -la' }),
    toolResult('two', listing),
  ];

  const managed = manageToolResults(messages, {
    effectiveInputBudget: 100_000,
    pressure: 'aggressive',
  });

  assert.equal(managed.deduplicated, 1);
  const contents = managed.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_result')
    .map((block) => (block.type === 'tool_result' ? block.content : ''));
  // The newest copy is the one kept verbatim.
  assert.match(contents[0] ?? '', /Identical to a later result/);
  assert.equal(contents[1], listing);
});

// ---------------------------------------------------------------------------
// 6-7. Decisions and constraints survive compaction
// ---------------------------------------------------------------------------
test('an explicit constraint and an active decision both survive compaction', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = workConversation(Math.floor(budgetOf() * 1.4));

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });
  const prepared = textOf(result.messages);

  assert.ok(result.estimatedTokens < estimateMessagesTokens(messages));
  assert.match(prepared, /card numbers/i, 'the stated constraint must survive');
  assert.match(prepared, /pgx/i, 'the active decision must survive');
  const decision = decisionOf(result);
  assert.ok(decision.preservedStateCategories.includes('constraints'));
  assert.equal(decision.verificationPassed, true);
});

test('a forced compaction still carries the constraint and the decision', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = workConversation(Math.floor(budgetOf() * 0.2));

  const result = await orchestrator.prepare({
    messages,
    modelCapabilities: CAPS,
    forceCompaction: true,
  });

  assert.equal(result.compacted, true);
  const prepared = textOf(result.messages);
  assert.match(prepared, /card numbers/i);
  assert.match(prepared, /pgx/i);
});

// ---------------------------------------------------------------------------
// 8. A superseded decision does not remain active
// ---------------------------------------------------------------------------
test('a decision the user overruled is recorded as superseded, not as current', () => {
  const messages = [
    msg('user', 'Use MySQL for the billing database.', 'u1'),
    msg('assistant', "I'll use MySQL for the billing database.", 'a1'),
    msg('user', 'Actually, use Postgres for the billing database instead.', 'u2'),
    msg('assistant', "I'll use Postgres for the billing database.", 'a2'),
  ];

  const state = deriveContextState(messages);

  assert.ok(
    state.decisions.some((entry) => /postgres/i.test(entry.text)),
    'the standing decision must be active',
  );
  assert.ok(
    !state.decisions.some((entry) => /mysql/i.test(entry.text)),
    'the overruled decision must not be active',
  );
  assert.ok(
    state.supersededDecisions.some((entry) => /mysql/i.test(entry.text)),
    'the overruled decision must be recorded as superseded',
  );
});

test('a rendered state never presents a superseded decision as a current one', () => {
  const state = deriveContextState([
    msg('user', 'Use MySQL for the billing database.', 'u1'),
    msg('assistant', "I'll use MySQL for the billing database.", 'a1'),
    msg('user', 'Actually, use Postgres for the billing database instead.', 'u2'),
    msg('assistant', "I'll use Postgres for the billing database.", 'a2'),
  ]);

  const rendered = renderContextState(state, 4_000);

  assert.match(rendered, /SUPERSEDED:/);
  assert.match(section(rendered, 'ACTIVE DECISIONS'), /Postgres/i);
  assert.ok(
    !/mysql/i.test(section(rendered, 'ACTIVE DECISIONS')),
    'MySQL must not appear under the active heading',
  );
  assert.match(section(rendered, 'SUPERSEDED'), /MySQL/i);
  // And nowhere else in the block either: a corrected statement restated as a
  // standing fact is the same failure wearing a different heading.
  const beforeSuperseded = rendered.slice(0, rendered.indexOf('SUPERSEDED:'));
  assert.ok(!/mysql/i.test(beforeSuperseded), 'a corrected statement must not read as current');
});

/** One section of a rendered state block, without the sections that follow it. */
function section(rendered: string, title: string): string {
  const start = rendered.indexOf(`${title}:`);
  if (start === -1) return '';
  const rest = rendered.slice(start + title.length + 1);
  const next = rest.search(/\n[A-Z][A-Z ]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('a superseded decision is ranked below the one that replaced it', () => {
  const messages = [
    msg('user', 'Use MySQL for the billing database.', 'u1'),
    msg('assistant', "I'll use MySQL for the billing database.", 'a1'),
    msg('user', 'Actually, use Postgres for the billing database instead.', 'u2'),
    msg('assistant', "I'll use Postgres for the billing database.", 'a2'),
  ];
  const state = deriveContextState(messages);
  const ranked = scoreMessageImportance(messages, state);

  const superseded = ranked[1];
  assert.ok(superseded);
  assert.ok(
    superseded.reasons.includes('superseded-decision'),
    'the overruled turn must be marked as such',
  );
});

// ---------------------------------------------------------------------------
// 9. A live error survives; a cleared one does not stay live
// ---------------------------------------------------------------------------
test('an unresolved tool error survives compaction', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = workConversation(Math.floor(budgetOf() * 1.4));

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  assert.match(textOf(result.messages), /pgxpool/i, 'the live build error must survive');
  assert.ok(decisionOf(result).state.errors >= 1);
});

test('an error a later run of the same tool cleared is no longer live', () => {
  const messages = [
    msg('user', 'build the service', 'u1'),
    toolCall('one', 'bash', { command: 'go build' }),
    toolResult('one', 'undefined reference to pgxpool.Connect', true),
    msg('assistant', 'Added the dependency.', 'a1'),
    toolCall('two', 'bash', { command: 'go build' }),
    toolResult('two', 'ok billing'),
    msg('user', 'good', 'u2'),
  ];

  const state = deriveContextState(messages);

  assert.equal(state.errors.length, 0, 'a cleared failure is history, not a live problem');
  assert.ok(state.completed.some((entry) => /pgxpool/i.test(entry.text)));
});

// ---------------------------------------------------------------------------
// 10-11. Irrelevant history goes; relevant history stays
// ---------------------------------------------------------------------------
test('selection drops unreferenced history and keeps what the request depends on', () => {
  const messages = [
    msg(
      'user',
      'The staging endpoint is at https://staging.example.test and the API version is v3.',
      'fact',
    ),
    msg('assistant', 'Noted the staging endpoint and version.', 'ack'),
    msg('assistant', 'The office wifi rotates on Tuesdays.', 'noise'),
    ...filler(4_000, 'chatter'),
    msg('user', 'Point the billing client at the staging endpoint.', 'ask'),
  ];
  const state = deriveContextState(messages);
  const importance = scoreMessageImportance(messages, state);

  const selection = selectContext({
    messages,
    state,
    importance,
    targetTokens: Math.floor(estimateMessagesTokens(messages) * 0.4),
    estimator: new DefaultTokenEstimator(),
  });

  const kept = textOf(selection.messages);
  assert.ok(selection.droppedIndices.length > 0, 'something had to give');
  assert.match(kept, /Point the billing client/, 'the current request always survives');
  assert.match(kept, /staging\.example\.test/, 'the fact the request depends on survives');
  assert.ok(!/wifi/i.test(kept), 'the unreferenced aside is the first thing to go');
  assert.ok(selection.droppedTiers.includes('low-value-history'));
});

test('a relevant historical fact is still available after the conversation is compacted', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = [
    msg(
      'user',
      'The staging endpoint is at https://staging.example.test and the API version is v3.',
      'fact',
    ),
    ...filler(Math.floor(budgetOf() * 1.2), 'chatter'),
    msg('user', 'Point the billing client at the staging endpoint.', 'ask'),
  ];

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  assert.match(textOf(result.messages), /staging\.example\.test/);
});

// ---------------------------------------------------------------------------
// 12. Tool protocol adjacency, on every path
// ---------------------------------------------------------------------------
test('a tool result is never separated from its call, whatever the layer decides', async () => {
  const scenarios: { name: string; messages: AgentMessage[]; force?: boolean }[] = [
    {
      name: 'trimming',
      messages: [msg('user', 'read it', 'u'), toolCall('a'), toolResult('a', 'q'.repeat(900_000))],
    },
    { name: 'selection', messages: workConversation(Math.floor(budgetOf() * 1.05)) },
    { name: 'compaction', messages: workConversation(Math.floor(budgetOf() * 2)) },
    { name: 'forced', messages: workConversation(1_000), force: true },
    {
      name: 'many pairs',
      messages: (() => {
        const out: AgentMessage[] = [msg('user', 'do the migration', 'ask')];
        for (let i = 0; i < 60; i += 1) {
          out.push(toolCall(`p${i}`, 'read_file', { path: `pkg/file${i}.go` }));
          out.push(toolResult(`p${i}`, 'w'.repeat(30_000)));
        }
        out.push(msg('user', 'carry on', 'last'));
        return out;
      })(),
    },
  ];

  for (const scenario of scenarios) {
    const orchestrator = new ContextOrchestrator({});
    const result = await orchestrator.prepare({
      messages: scenario.messages,
      modelCapabilities: CAPS,
      ...(scenario.force ? { forceCompaction: true } : {}),
    });

    const callIds = new Set(
      result.messages.flatMap((message) =>
        message.content.filter((block) => block.type === 'tool_call').map((block) => block.id),
      ),
    );
    const resultIds = new Set(
      result.messages.flatMap((message) =>
        message.content
          .filter((block) => block.type === 'tool_result')
          .map((block) => (block.type === 'tool_result' ? block.toolCallId : '')),
      ),
    );
    for (const id of resultIds) {
      assert.ok(callIds.has(id), `${scenario.name}: tool result ${id} lost its call`);
    }
    for (const id of callIds) {
      assert.ok(resultIds.has(id), `${scenario.name}: tool call ${id} lost its result`);
    }
    assert.ok(result.messages.length > 0, `${scenario.name}: returned no messages`);
    assert.ok(
      result.estimatedTokens <= budgetOf(),
      `${scenario.name}: ${result.estimatedTokens} exceeds the budget`,
    );
  }
});

// ---------------------------------------------------------------------------
// 13. Summarisation failure degrades deterministically
// ---------------------------------------------------------------------------
test('a summariser that throws falls back to a deterministic structured summary', async () => {
  let calls = 0;
  const failing: CompactionSummarizer = {
    async summarize() {
      calls += 1;
      throw new Error('bedrock unreachable');
    },
  };
  const orchestrator = new ContextOrchestrator({ summarizer: failing });
  const messages = workConversation(Math.floor(budgetOf() * 2));

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  assert.ok(calls >= 1, 'the configured summariser must be attempted');
  const decision = decisionOf(result);
  assert.equal(decision.fallbackUsed, true);
  assert.equal(decision.strategy, 'deterministic');
  // And the fallback is the structured state, not a shrug.
  const prepared = textOf(result.messages);
  assert.match(prepared, /CURRENT GOAL:|CONSTRAINTS:/);
  assert.match(prepared, /card numbers/i);
});

test('a summariser that answers is used, and its answer is led by the derived state', async () => {
  const seen: { outline?: string | undefined; ceiling?: number | undefined } = {};
  const summarizer: CompactionSummarizer = {
    async summarize(input) {
      seen.outline = input.stateOutline;
      seen.ceiling = input.maxSummaryTokens;
      return { summary: 'The model wrote this part.', strategy: 'llm-summarization' };
    },
  };
  const orchestrator = new ContextOrchestrator({ summarizer });
  const messages = workConversation(Math.floor(budgetOf() * 2));

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });
  const prepared = textOf(result.messages);
  const decision = decisionOf(result);

  assert.equal(decision.strategy, 'llm-summarization');
  assert.equal(decision.fallbackUsed, false);
  assert.ok(seen.outline && seen.outline.includes('CURRENT GOAL:'), 'the outline must be supplied');
  assert.ok(
    typeof seen.ceiling === 'number' && seen.ceiling > 0,
    'the summariser must be told its allowance rather than choosing one',
  );
  assert.match(prepared, /The model wrote this part\./);
  // The deterministic outline still leads, so the constraint cannot be lost to a
  // paraphrase.
  assert.ok(prepared.indexOf('CONSTRAINTS:') < prepared.indexOf('The model wrote this part.'));
});

// ---------------------------------------------------------------------------
// 14. The provider rejects the context
// ---------------------------------------------------------------------------
test('a provider that rejects the context is retried once with a smaller one', async () => {
  let attempts = 0;
  let retriedTokens = Number.MAX_SAFE_INTEGER;
  const provider = new ScriptedModelProvider([
    () => {
      attempts += 1;
      throw Object.assign(new Error('prompt is too long'), { status: 413 });
    },
    (request) => {
      attempts += 1;
      retriedTokens = estimateMessagesTokens(request.messages);
      return [
        { type: 'text_delta' as const, delta: 'recovered' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const initial = workConversation(40_000);
  const session = createAgentSession({
    provider,
    modelCapabilities: CAPS,
    initialMessages: initial,
  });

  const events = await collect(session.run({ prompt: 'carry on' }));

  assert.equal(attempts, 2);
  assert.ok(
    events.some((event) => event.type === 'warning' && event.code === 'REACTIVE_COMPACTION'),
  );
  assert.ok(
    retriedTokens < estimateMessagesTokens(initial),
    'the retry must be smaller than what was rejected',
  );
  assert.ok(events.some((event) => event.type === 'session.completed'));
  // The retry is reported as such rather than as an ordinary compaction.
  const usage = events.filter((event) => event.type === 'context.usage');
  const last = usage[usage.length - 1];
  assert.ok(last && last.type === 'context.usage');
  assert.equal(last.action, 'reactive-compaction');
});

// ---------------------------------------------------------------------------
// 15. Verification failure restores what was lost
// ---------------------------------------------------------------------------
test('a compaction that loses the goal and the constraint has them restored', async () => {
  // A stand-in manager that throws the conversation away and keeps the last message.
  // Exactly the failure verification exists to catch: cheap, plausible, and silently
  // wrong.
  const lossy: ContextManager = {
    async prepare(request) {
      const last = request.messages[request.messages.length - 1];
      const messages = last ? [last] : request.messages;
      return {
        messages,
        estimatedTokens: estimateMessagesTokens(messages),
        compacted: true,
        tokensBefore: estimateMessagesTokens(request.messages),
        metadata: { strategy: 'deterministic' },
      };
    },
  };
  const orchestrator = new ContextOrchestrator({ manager: lossy });
  const messages = workConversation(Math.floor(budgetOf() * 1.5));

  // Forced, so the run reaches the compaction stage rather than being satisfied by
  // selection — the lossy manager is the thing under test.
  const result = await orchestrator.prepare({
    messages,
    modelCapabilities: CAPS,
    forceCompaction: true,
  });
  const decision = decisionOf(result);
  const prepared = textOf(result.messages);

  assert.equal(decision.recoveryPerformed, true);
  assert.equal(decision.action, 'recovery');
  assert.match(prepared, /card numbers/i, 'the constraint must be restored');
  assert.match(prepared, /Postgres|billing/i, 'the goal must be restored');
  assert.equal(decision.verificationPassed, true, 'recovery must actually fix it');
  assert.ok(result.estimatedTokens <= budgetOf());
});

test('verification names what is missing and what survived', () => {
  const messages = workConversation(2_000);
  const state = deriveContextState(messages);

  const intact = verifyContext({
    messages,
    state,
    estimatedTokens: estimateMessagesTokens(messages),
    effectiveInputBudget: budgetOf(),
  });
  assert.equal(intact.passed, true);
  assert.ok(intact.confirmed.includes('constraints'));

  const gutted = verifyContext({
    messages: [messages[messages.length - 1]!],
    state,
    estimatedTokens: 10,
    effectiveInputBudget: budgetOf(),
  });
  assert.equal(gutted.passed, false);
  assert.ok(gutted.issues.includes('missing-constraints'));
  assert.ok(gutted.missingItems.length > 0);
});

test('an orphaned tool result is caught before it reaches a provider', () => {
  const state = deriveContextState([]);
  const orphan = verifyContext({
    messages: [toolResult('gone', 'the file contents')],
    state,
    estimatedTokens: 10,
    effectiveInputBudget: 1_000,
  });
  assert.ok(orphan.issues.includes('orphaned-tool-result'));
});

// ---------------------------------------------------------------------------
// 16-18. Model independence
// ---------------------------------------------------------------------------
test('the pipeline derives its budget from whatever model it is given', async () => {
  const models: { name: string; caps: ModelContextCapabilities }[] = [
    { name: '128K', caps: { contextWindow: 128_000, maxOutputTokens: 4_096 } },
    { name: '256K', caps: { contextWindow: 256_000, maxOutputTokens: 16_000 } },
    { name: '1M', caps: { contextWindow: 1_000_000, maxOutputTokens: 32_000 } },
  ];

  let previous = 0;
  for (const model of models) {
    const orchestrator = new ContextOrchestrator({});
    const budget = budgetOf(model.caps);
    const messages = workConversation(Math.floor(budget * 1.3));

    const result = await orchestrator.prepare({ messages, modelCapabilities: model.caps });

    assert.equal(
      result.budget?.effectiveInputBudget,
      model.caps.contextWindow -
        model.caps.maxOutputTokens -
        DEFAULT_CONTEXT_POLICY.safetyMarginTokens,
      `${model.name}: budget not derived from the model`,
    );
    assert.ok(
      result.estimatedTokens <= budget,
      `${model.name}: ${result.estimatedTokens} exceeds the ${budget}-token budget`,
    );
    assert.match(textOf(result.messages), /card numbers/i, `${model.name}: lost the constraint`);
    assert.ok(
      result.budget!.effectiveInputBudget > previous,
      `${model.name}: budget did not scale`,
    );
    previous = result.budget!.effectiveInputBudget;
  }
});

test('the same session survives the model growing and shrinking underneath it', async () => {
  const orchestrator = new ContextOrchestrator({});
  const small: ModelContextCapabilities = { contextWindow: 128_000, maxOutputTokens: 4_096 };
  const large: ModelContextCapabilities = { contextWindow: 1_000_000, maxOutputTokens: 32_000 };
  const messages = workConversation(Math.floor(budgetOf(small) * 1.2));

  const onLarge = await orchestrator.prepare({ messages, modelCapabilities: large });
  const onSmall = await orchestrator.prepare({ messages, modelCapabilities: small });

  // Comfortable on the big model, over the line on the small one — same messages.
  assert.equal(decisionOf(onLarge).action, 'none');
  assert.notEqual(decisionOf(onSmall).action, 'none');
  assert.ok(onSmall.estimatedTokens <= budgetOf(small));
});

// ---------------------------------------------------------------------------
// 19. Every threshold from 1 to 99
// ---------------------------------------------------------------------------
test('every threshold from 1 to 99 is honoured, and none of them throws', async () => {
  for (let percent = 1; percent <= 99; percent += 1) {
    const orchestrator = new ContextOrchestrator({ policy: contextPolicyFromPercent(percent) });
    const messages = workConversation(Math.floor(budgetOf() * 1.1));

    const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

    const ceiling = budgetOf() * (percent / 100);
    assert.ok(
      result.estimatedTokens <= ceiling,
      `${percent}%: ${result.estimatedTokens} tokens exceeds its own ${Math.floor(ceiling)}-token line`,
    );
    assert.ok(result.messages.length >= 1, `${percent}%: returned no messages`);
    // The pressure the caller is told about is the pressure the configured policy
    // implies, not the default one.
    const fraction = estimateMessagesTokens(messages) / budgetOf();
    assert.equal(
      decisionOf(result).pressure,
      classifyPressure(fraction, contextPolicyFromPercent(percent) as never),
      `${percent}%: pressure disagrees with the configured policy`,
    );
  }
});

// ---------------------------------------------------------------------------
// 20. A manual compaction on a fresh chat
// ---------------------------------------------------------------------------
test('forcing compaction on a fresh chat is skipped rather than made worse', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = [msg('user', 'hello', 'u1'), msg('assistant', 'hi there', 'a1')];
  const before = estimateMessagesTokens(messages);

  const result = await orchestrator.prepare({
    messages,
    modelCapabilities: CAPS,
    forceCompaction: true,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.metadata?.skipped, 'already-minimal');
  assert.ok(result.estimatedTokens <= before);
});

test('a session reports a requested compaction that had nothing to do', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    compactContext: true,
    initialMessages: [msg('user', 'hello', 'u1')],
  });

  const events = await collect(session.run({ prompt: 'hi' }));

  assert.equal(events.filter((event) => event.type === 'context.compaction.completed').length, 0);
  assert.ok(
    events.some((event) => event.type === 'warning' && event.code === 'CONTEXT_COMPACTION_SKIPPED'),
  );
});

// ---------------------------------------------------------------------------
// 21. The canonical history is never mutated
// ---------------------------------------------------------------------------
test('no stage of the pipeline touches the messages it was given', async () => {
  const orchestrator = new ContextOrchestrator({});
  const messages = workConversation(Math.floor(budgetOf() * 1.6));
  const snapshot = JSON.stringify(messages);

  const result = await orchestrator.prepare({ messages, modelCapabilities: CAPS });

  assert.equal(JSON.stringify(messages), snapshot, 'the input array was mutated');
  assert.notEqual(result.messages, messages);
});

test('a session that compacts keeps every message in its canonical history', async () => {
  const initial = workConversation(Math.floor(budgetOf() * 1.3));
  const ids = initial.map((message) => message.id);
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    initialMessages: initial,
  });

  const events = await collect(session.run({ prompt: 'carry on' }));

  const stored = session.messages.map((message) => message.id);
  for (const id of ids) assert.ok(stored.includes(id), `history lost ${id}`);
  assert.ok(events.some((event) => event.type === 'context.usage'));
});

// ---------------------------------------------------------------------------
// The session's events
// ---------------------------------------------------------------------------
test('a session emits selection, verification and usage detail for a turn that acted', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    initialMessages: workConversation(Math.floor(budgetOf() * 1.3)),
  });

  const events = await collect(session.run({ prompt: 'carry on with the retry wrapper' }));

  const selection = events.find((event) => event.type === 'context.selection');
  assert.ok(selection && selection.type === 'context.selection');
  assert.ok(selection.kept > 0);

  const verification = events.find((event) => event.type === 'context.verification');
  assert.ok(verification && verification.type === 'context.verification');
  assert.equal(verification.passed, true);
  assert.ok(verification.preserved.length > 0);

  const usage = events.find((event) => event.type === 'context.usage');
  assert.ok(usage && usage.type === 'context.usage');
  assert.ok(usage.action !== undefined && usage.action !== 'none');
  assert.equal(usage.verification, 'passed');
  assert.equal(usage.turn, 1);
  assert.ok(usage.state && usage.state.constraints >= 1);
  // No conversation content anywhere in the telemetry.
  assert.ok(!JSON.stringify(usage).includes('card numbers'));
});

test('a quiet turn emits usage and nothing else from the context layer', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    initialMessages: [msg('user', 'hello', 'u1')],
  });

  const events = await collect(session.run({ prompt: 'hi' }));

  assert.equal(events.filter((event) => event.type === 'context.selection').length, 0);
  assert.equal(events.filter((event) => event.type === 'context.verification').length, 0);
  assert.equal(events.filter((event) => event.type === 'context.recovery').length, 0);
  const usage = events.find((event) => event.type === 'context.usage');
  assert.ok(usage && usage.type === 'context.usage');
  assert.equal(usage.action, 'none');
});

// ---------------------------------------------------------------------------
// 25. One dial, and only one
// ---------------------------------------------------------------------------
test('an agent record accepts a compaction percentage and nothing else about context', () => {
  const limits = (extra: Record<string, unknown>) => ({ maxTurns: 8, ...extra });

  assert.equal(agentLimitsSchema.safeParse(limits({})).success, true);
  for (const percent of [1, 50, 80, 99]) {
    assert.equal(
      agentLimitsSchema.safeParse(limits({ compactionThresholdPercent: percent })).success,
      true,
      `${percent} must be accepted`,
    );
  }
  assert.equal(
    agentLimitsSchema.safeParse(limits({ compactionThresholdPercent: 0 })).success,
    false,
  );
  assert.equal(
    agentLimitsSchema.safeParse(limits({ compactionThresholdPercent: 100 })).success,
    false,
  );

  // Every internal dial the orchestration layer derives is refused as configuration.
  // These are the fields a user would otherwise be asked to tune, and the schema is
  // where that request is turned down.
  for (const field of [
    'retainRecentTokens',
    'warningThreshold',
    'aggressiveThreshold',
    'maxToolResultTokens',
    'safetyMarginTokens',
    'summaryBudgetFraction',
    'summarySize',
    'contextSelectionStrategy',
    'memorySize',
    'retrievalCount',
    'rankingWeights',
    'summarizationModel',
  ]) {
    assert.equal(
      agentLimitsSchema.safeParse(limits({ [field]: 1_000 })).success,
      false,
      `${field} must not be configurable on an agent record`,
    );
  }
});

test('a session given nothing but a percentage runs the whole pipeline', async () => {
  const events = await collect(
    createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'ok' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      modelCapabilities: CAPS,
      // The entire configuration.
      limits: { maxTurns: 4, compactionThresholdPercent: 50 },
      initialMessages: workConversation(Math.floor(budgetOf() * 0.62)),
    }).run({ prompt: 'carry on' }),
  );

  const usage = events.find((event) => event.type === 'context.usage');
  assert.ok(usage && usage.type === 'context.usage');
  assert.ok(
    usage.usedPercent <= 50,
    `left at ${usage.usedPercent}% of a budget the record capped at 50%`,
  );
  assert.ok(usage.action !== undefined && usage.action !== 'none');
  assert.equal(usage.verification, 'passed');
  assert.equal(events.filter((event) => event.type === 'context.compaction.completed').length, 1);
});
