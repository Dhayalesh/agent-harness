/**
 * The three tiers of the context policy, and the guarantees compaction makes.
 *
 * `dynamic-compaction.test.ts` covers the budget arithmetic and the shape of the
 * result. This file covers what the policy promises and what used to be missing:
 *
 *   1-3.   `aggressiveThreshold` and `maxToolResultTokens` do something
 *   4-6.   Compaction cannot return a context that is still over budget
 *   7-8.   Compaction lands under the threshold that was configured, at any percent
 *   9-11.  Pressure is classified and reported
 *   12-14. A forced compaction that cannot help says so instead of doing harm
 *   15-17. The session surfaces pressure, skips, and the pre-compaction peak
 *   18-19. The invariants the earlier behaviour already had are still held
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPressure,
  createAgentSession,
  DEFAULT_CONTEXT_POLICY,
  DynamicCompactingContextManager,
  contextPolicyFromPercent,
  estimateMessagesTokens,
  ScriptedModelProvider,
  type AgentEvent,
  type AgentMessage,
  type ModelContextCapabilities,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAPS: ModelContextCapabilities = { contextWindow: 200_000, maxOutputTokens: 8_192 };

/** The budget the manager derives from CAPS under the default safety margin. */
function budgetOf(
  capabilities: ModelContextCapabilities = CAPS,
  safetyMargin = DEFAULT_CONTEXT_POLICY.safetyMarginTokens,
): number {
  return capabilities.contextWindow - capabilities.maxOutputTokens - safetyMargin;
}

let sequence = 0;
function msg(role: 'user' | 'assistant', text: string, id = `m${(sequence += 1)}`): AgentMessage {
  return { id, role, createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text }] };
}

function toolCallMsg(id: string, name = 'read_file'): AgentMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: [{ type: 'tool_call', id: `call-${id}`, name, input: {} }],
  };
}

function toolResultMsg(id: string, content: string, isError = false): AgentMessage {
  return {
    id: `r-${id}`,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: [{ type: 'tool_result', toolCallId: `call-${id}`, content, isError }],
  };
}

/**
 * A plain conversation of close to the requested token size.
 *
 * Calibrated against the estimator rather than assumed: a message costs its text
 * plus its id, role and timestamp, and guessing that overhead is how a test that
 * means "75% full" ends up at 96% and asserts the wrong tier.
 */
function conversation(targetTokens: number): AgentMessage[] {
  const perMessage = 400;
  const unitCost = estimateMessagesTokens([msg('user', 'x'.repeat(perMessage), 'probe')]);
  const count = Math.max(2, Math.round(targetTokens / unitCost));
  return Array.from({ length: count }, (_, i) =>
    msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(perMessage)),
  );
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) =>
      message.content.map((block) =>
        block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : '',
      ),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. Aggressive tier: an oversized tool result is trimmed, not summarised away
// ---------------------------------------------------------------------------
test('an oversized tool result is trimmed instead of compacting the conversation', async () => {
  const manager = new DynamicCompactingContextManager({});
  const messages = [
    msg('user', 'read the log please', 'ask'),
    toolCallMsg('one'),
    // On its own larger than 90% of the budget.
    toolResultMsg('one', 'y'.repeat(700_000)),
  ];
  const before = estimateMessagesTokens(messages);
  assert.ok(before > budgetOf() * DEFAULT_CONTEXT_POLICY.compactionThreshold);

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  // Trimming was enough, so the conversation itself survives intact.
  assert.equal(result.compacted, false);
  assert.equal(result.messages.length, 3);
  assert.equal(result.metadata?.toolResultsTruncated, 1);
  assert.ok(result.estimatedTokens < budgetOf());
  // The user's own words are untouched.
  assert.ok(textOf(result.messages).includes('read the log please'));
});

// ---------------------------------------------------------------------------
// 2. maxToolResultTokens is honoured
// ---------------------------------------------------------------------------
test('a tool result is trimmed to the policy allowance and says how much it lost', async () => {
  const manager = new DynamicCompactingContextManager({
    policy: { maxToolResultTokens: 1_000 },
  });
  const messages = [
    ...conversation(160_000),
    toolCallMsg('big'),
    toolResultMsg('big', 'y'.repeat(400_000)),
  ];

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  const trimmed = result.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_result');
  assert.equal(trimmed.length, 1);
  const block = trimmed[0];
  assert.ok(block && block.type === 'tool_result');
  // 1 000 tokens ≈ 4 000 characters, plus the notice that replaces the middle.
  assert.ok(block.content.length <= 4_400, `kept ${block.content.length} characters`);
  assert.match(block.content, /characters of this tool result were removed/);
});

// ---------------------------------------------------------------------------
// 3. Below the aggressive threshold nothing is touched at all
// ---------------------------------------------------------------------------
test('below the aggressive threshold the messages are returned by reference', async () => {
  const manager = new DynamicCompactingContextManager({});
  // ~75% of the budget: past warning, short of aggressive.
  const messages = conversation(Math.floor(budgetOf() * 0.75));
  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(result.metadata?.toolResultsTruncated, undefined);
});

// ---------------------------------------------------------------------------
// 4. A single message larger than the whole budget is brought inside it
// ---------------------------------------------------------------------------
test('one message larger than the entire budget is brought under it', async () => {
  const manager = new DynamicCompactingContextManager({});
  // The retention walk always keeps the last message, so this is the case that
  // could never be relieved by dropping or summarising anything.
  const messages = [msg('user', 'q'.repeat(2_000_000), 'only')];

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  assert.ok(
    result.estimatedTokens <= budgetOf(),
    `${result.estimatedTokens} still exceeds ${budgetOf()}`,
  );
  assert.equal(result.metadata?.stillOverBudget, undefined);
  assert.equal(result.metadata?.skipped, 'already-minimal');
  assert.equal(result.messages.length, 1);
});

// ---------------------------------------------------------------------------
// 5. A trailing tool result several times the window is brought inside it
// ---------------------------------------------------------------------------
test('a trailing tool result larger than the window is brought under the budget', async () => {
  const manager = new DynamicCompactingContextManager({});
  const messages = [
    ...conversation(150_000),
    toolCallMsg('huge'),
    toolResultMsg('huge', 'y'.repeat(4_000_000)),
  ];

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  assert.ok(
    result.estimatedTokens <= budgetOf(),
    `${result.estimatedTokens} still exceeds ${budgetOf()}`,
  );
  assert.equal(result.metadata?.stillOverBudget, undefined);
});

// ---------------------------------------------------------------------------
// 6. Many oversized tool results at once
// ---------------------------------------------------------------------------
test('a run full of oversized tool results is brought under the budget', async () => {
  const manager = new DynamicCompactingContextManager({});
  const messages: AgentMessage[] = [msg('user', 'do the migration', 'ask')];
  for (let i = 0; i < 40; i += 1) {
    messages.push(toolCallMsg(`c${i}`));
    messages.push(toolResultMsg(`c${i}`, 'z'.repeat(40_000)));
  }
  assert.ok(estimateMessagesTokens(messages) > budgetOf());

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });

  assert.ok(result.estimatedTokens <= budgetOf());
  assert.equal(result.metadata?.stillOverBudget, undefined);
});

// ---------------------------------------------------------------------------
// 7. Compaction lands under the threshold that was configured
// ---------------------------------------------------------------------------
test('compaction lands under the configured threshold at every percentage', async () => {
  for (const percent of [1, 5, 10, 25, 50, 75, 80, 90, 95, 99]) {
    const manager = new DynamicCompactingContextManager({
      policy: contextPolicyFromPercent(percent),
    });
    const messages = conversation(Math.floor(budgetOf() * 1.1));

    const result = await manager.prepare({ messages, modelCapabilities: CAPS });

    assert.equal(result.compacted, true, `percent ${percent} did not compact`);
    const ceiling = budgetOf() * (percent / 100);
    assert.ok(
      result.estimatedTokens <= ceiling,
      `percent ${percent}: ${result.estimatedTokens} tokens exceeds its own ${Math.floor(ceiling)}-token line`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Compaction is triggered by the configured threshold, not the default one
// ---------------------------------------------------------------------------
test('a low threshold compacts a context the default policy would have left alone', async () => {
  const messages = conversation(Math.floor(budgetOf() * 0.55));

  const relaxed = await new DynamicCompactingContextManager({}).prepare({
    messages,
    modelCapabilities: CAPS,
  });
  assert.equal(relaxed.compacted, false);

  const strict = await new DynamicCompactingContextManager({
    policy: contextPolicyFromPercent(50),
  }).prepare({ messages, modelCapabilities: CAPS });
  assert.equal(strict.compacted, true);
});

// ---------------------------------------------------------------------------
// 9-11. Pressure classification
// ---------------------------------------------------------------------------
test('pressure names the threshold the measurement crossed', () => {
  const policy = DEFAULT_CONTEXT_POLICY;
  assert.equal(classifyPressure(0.1, policy), 'nominal');
  assert.equal(classifyPressure(0.69, policy), 'nominal');
  assert.equal(classifyPressure(0.7, policy), 'warning');
  assert.equal(classifyPressure(0.79, policy), 'warning');
  assert.equal(classifyPressure(0.8, policy), 'aggressive');
  assert.equal(classifyPressure(0.89, policy), 'aggressive');
  assert.equal(classifyPressure(0.9, policy), 'critical');
  assert.equal(classifyPressure(5, policy), 'critical');
});

test('a passthrough result reports the pressure it measured', async () => {
  const manager = new DynamicCompactingContextManager({});

  const quiet = await manager.prepare({
    messages: conversation(Math.floor(budgetOf() * 0.2)),
    modelCapabilities: CAPS,
  });
  assert.equal(quiet.metadata?.pressure, 'nominal');

  const warning = await manager.prepare({
    messages: conversation(Math.floor(budgetOf() * 0.75)),
    modelCapabilities: CAPS,
  });
  assert.equal(warning.metadata?.pressure, 'warning');

  const aggressive = await manager.prepare({
    messages: conversation(Math.floor(budgetOf() * 0.85)),
    modelCapabilities: CAPS,
  });
  assert.equal(aggressive.metadata?.pressure, 'aggressive');
});

test('a compacted result reports critical pressure', async () => {
  const manager = new DynamicCompactingContextManager({});
  const result = await manager.prepare({
    messages: conversation(Math.floor(budgetOf() * 1.1)),
    modelCapabilities: CAPS,
  });
  assert.equal(result.compacted, true);
  assert.equal(result.metadata?.pressure, 'critical');
});

// ---------------------------------------------------------------------------
// 12-14. A forced compaction that cannot help
// ---------------------------------------------------------------------------
test('forcing compaction on a two-line chat is skipped rather than made worse', async () => {
  const manager = new DynamicCompactingContextManager({});
  const messages = [msg('user', 'hello', 'u1'), msg('assistant', 'hi there', 'a1')];
  const before = estimateMessagesTokens(messages);

  const result = await manager.prepare({
    messages,
    modelCapabilities: CAPS,
    forceCompaction: true,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.metadata?.skipped, 'already-minimal');
  assert.equal(result.messages, messages);
  assert.equal(result.estimatedTokens, before);
});

test('forcing compaction on a real conversation still compacts it', async () => {
  const manager = new DynamicCompactingContextManager({});
  const messages = conversation(20_000);
  const before = estimateMessagesTokens(messages);

  const result = await manager.prepare({
    messages,
    modelCapabilities: CAPS,
    forceCompaction: true,
  });

  assert.equal(result.compacted, true);
  assert.ok(result.estimatedTokens < before);
  assert.ok(
    result.messages.some((message) =>
      message.content.some(
        (block) => block.type === 'text' && block.text.includes('[Compacted earlier conversation]'),
      ),
    ),
  );
});

test('a skip and a compaction are never both reported, whatever the input', async () => {
  const scenarios: Array<{ name: string; messages: AgentMessage[]; force?: boolean }> = [
    { name: 'empty-ish', messages: [msg('user', 'hi', 's1')], force: true },
    {
      name: 'two lines forced',
      messages: [msg('user', 'hi', 's2'), msg('assistant', 'hello', 's3')],
      force: true,
    },
    { name: 'over budget', messages: conversation(Math.floor(budgetOf() * 1.2)) },
    { name: 'single huge message', messages: [msg('user', 'q'.repeat(1_500_000), 's4')] },
    {
      name: 'huge trailing tool result',
      messages: [
        msg('user', 'go', 's5'),
        toolCallMsg('t'),
        toolResultMsg('t', 'y'.repeat(1_500_000)),
      ],
    },
    {
      name: 'retention larger than the budget',
      messages: conversation(Math.floor(budgetOf() * 1.1)),
    },
  ];

  for (const scenario of scenarios) {
    const manager = new DynamicCompactingContextManager({});
    const before = estimateMessagesTokens(scenario.messages);
    const result = await manager.prepare({
      messages: scenario.messages,
      modelCapabilities: CAPS,
      ...(scenario.force ? { forceCompaction: true } : {}),
    });

    if (result.metadata?.skipped) {
      assert.equal(result.compacted, false, `${scenario.name}: skipped yet reported as compacted`);
    }
    if (result.compacted) {
      assert.equal(result.metadata?.skipped, undefined, `${scenario.name}: compacted yet skipped`);
      assert.ok(
        result.estimatedTokens < before,
        `${scenario.name}: compaction did not reduce the context`,
      );
    }
    // Whatever route it took, the result is inside the budget it was given.
    assert.ok(
      result.estimatedTokens <= budgetOf(),
      `${scenario.name}: ${result.estimatedTokens} tokens exceeds the ${budgetOf()}-token budget`,
    );
  }
});

// ---------------------------------------------------------------------------
// 15. The session warns at the tier the policy names
// ---------------------------------------------------------------------------
test('the session warns about context pressure below the compaction line', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    initialMessages: conversation(Math.floor(budgetOf() * 0.75)),
  });

  const events = await collect(session.run({ prompt: 'carry on' }));
  const warning = events.find(
    (event) => event.type === 'warning' && event.code === 'CONTEXT_PRESSURE',
  );
  assert.ok(warning, 'expected a CONTEXT_PRESSURE warning');
  assert.equal(events.filter((event) => event.type === 'context.compaction.completed').length, 0);
});

// ---------------------------------------------------------------------------
// 16. A requested compaction that does nothing says so
// ---------------------------------------------------------------------------
test('a requested compaction with nothing to do reports a skip', async () => {
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
  const warning = events.find(
    (event) => event.type === 'warning' && event.code === 'CONTEXT_COMPACTION_SKIPPED',
  );
  assert.ok(warning, 'a compaction that did nothing must say so');
});

// ---------------------------------------------------------------------------
// 17. context.usage carries the pre-compaction peak
// ---------------------------------------------------------------------------
test('context.usage carries the peak that triggered the compaction', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    initialMessages: conversation(Math.floor(budgetOf() * 1.1)),
  });

  const events = await collect(session.run({ prompt: 'carry on' }));
  const usage = events.find((event) => event.type === 'context.usage');
  assert.ok(usage && usage.type === 'context.usage');
  assert.equal(usage.compacted, true);
  assert.ok(usage.peakTokens !== undefined, 'the peak must be reported');
  assert.ok(usage.peakTokens > usage.usedTokens, 'the peak must exceed what was sent');
  assert.ok((usage.peakPercent ?? 0) > usage.usedPercent);
  assert.equal(usage.pressure, 'critical');
});

// ---------------------------------------------------------------------------
// 18. Auto-compaction fires at the percentage the agent configured
// ---------------------------------------------------------------------------
test('a session compacts automatically at the percentage its limits asked for', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    modelCapabilities: CAPS,
    limits: { maxTurns: 4, compactionThresholdPercent: 50 },
    // 60% of the budget: over the agent's 50% line, well under the default 90%.
    initialMessages: conversation(Math.floor(budgetOf() * 0.6)),
  });

  const events = await collect(session.run({ prompt: 'carry on' }));

  const completed = events.filter((event) => event.type === 'context.compaction.completed');
  assert.equal(completed.length, 1, 'the configured threshold must trigger compaction');
  const usage = events.find((event) => event.type === 'context.usage');
  assert.ok(usage && usage.type === 'context.usage');
  assert.ok(
    usage.usedPercent <= 50,
    `compacted to ${usage.usedPercent}%, which is still above the 50% that was asked for`,
  );
});

// ---------------------------------------------------------------------------
// 19. The old invariants still hold
// ---------------------------------------------------------------------------
test('a tool result is never separated from the call that produced it', async () => {
  const manager = new DynamicCompactingContextManager({ policy: { retainRecentTokens: 2_000 } });
  const messages: AgentMessage[] = [...conversation(Math.floor(budgetOf() * 1.1))];
  messages.push(toolCallMsg('last'));
  messages.push(toolResultMsg('last', 'the file contents'));

  const result = await manager.prepare({ messages, modelCapabilities: CAPS });
  assert.equal(result.compacted, true);

  // Every tool result kept verbatim has its call in the same prepared context.
  const callIds = new Set(
    result.messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_call').map((block) => block.id),
    ),
  );
  for (const message of result.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      assert.ok(
        callIds.has(block.toolCallId),
        `tool result ${block.toolCallId} was kept without its call`,
      );
    }
  }
});

test('compaction never mutates the canonical session history', async () => {
  const initial = conversation(Math.floor(budgetOf() * 1.1));
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

  await collect(session.run({ prompt: 'carry on' }));

  const stored = session.messages.map((message) => message.id);
  for (const id of ids) assert.ok(stored.includes(id), `history lost ${id}`);
});
