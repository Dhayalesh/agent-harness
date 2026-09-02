import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  projectContextItems,
  type AgentMessage,
  type ContextProjectionRequest,
} from '../../src/index.js';

function text(
  id: string,
  role: AgentMessage['role'],
  content: string,
  createdAt: string,
): AgentMessage {
  return {
    id,
    role,
    createdAt,
    content: [{ type: 'text', text: content }],
  };
}

function call(
  messageId: string,
  callId: string,
  name: string,
  input: unknown,
  createdAt: string,
): AgentMessage {
  return {
    id: messageId,
    role: 'assistant',
    createdAt,
    content: [{ type: 'tool_call', id: callId, name, input }],
  };
}

function result(
  messageId: string,
  callId: string,
  content: string,
  createdAt: string,
  isError = false,
  metadata?: Record<string, unknown>,
): AgentMessage {
  return {
    id: messageId,
    role: 'user',
    createdAt,
    content: [
      {
        type: 'tool_result',
        toolCallId: callId,
        content,
        isError,
        ...(metadata === undefined ? {} : { metadata }),
      },
    ],
  };
}

test('projects final context in deterministic category order with stable provenance', () => {
  const messages: AgentMessage[] = [
    text('conversation', 'assistant', 'Earlier answer', '2026-01-01T00:00:02.000Z'),
    text('current', 'user', 'What is the current release?', '2026-01-01T00:00:04.000Z'),
    text('task', 'assistant', '## Current State\nRelease check pending', '2026-01-01T00:00:03.000Z'),
    call(
      'search-call-message',
      'search-call',
      'web_search',
      { query: 'current release' },
      '2026-01-01T00:00:05.000Z',
    ),
    result(
      'search-result',
      'search-call',
      'Version 4.2',
      '2026-01-01T00:00:06.000Z',
      false,
      { provider: 'test' },
    ),
    call(
      'planned-call-message',
      'planned-call',
      'web_fetch',
      { url: 'https://example.test/pending' },
      '2026-01-01T00:00:07.000Z',
    ),
    call(
      'failed-call-message',
      'failed-call',
      'bash',
      { command: 'exit 1' },
      '2026-01-01T00:00:08.000Z',
    ),
    result(
      'failed-result',
      'failed-call',
      'command failed',
      '2026-01-01T00:00:09.000Z',
      true,
    ),
  ];
  const request: ContextProjectionRequest = {
    messages,
    currentRequestId: 'current',
    systemPrompt: 'Answer from model-visible context only.',
  };

  const projected = projectContextItems(request);

  assert.deepEqual(
    projected.map((item) => item.type),
    [
      'system_context',
      'user_request',
      'conversation',
      'task_state',
      'retrieved_content',
      'execution_state',
    ],
  );
  assert.deepEqual(
    projected.map((item) => item.id),
    projectContextItems(structuredClone(request)).map((item) => item.id),
  );

  const evidence = projected.find(
    (item) => item.source.kind === 'tool' && item.source.name === 'web_search',
  );
  assert.ok(evidence);
  assert.equal(evidence.content, 'Version 4.2');
  assert.deepEqual(evidence.provenance, {
    sourceMessageId: 'search-result',
    toolCall: {
      id: 'search-call',
      name: 'web_search',
      input: { query: 'current release' },
    },
    toolResult: {
      messageId: 'search-result',
      toolCallId: 'search-call',
      content: 'Version 4.2',
      isError: false,
      metadata: { provider: 'test' },
    },
  });

  const failure = projected.find(
    (item) => item.source.kind === 'tool' && item.source.name === 'bash',
  );
  assert.ok(failure);
  assert.equal(failure.type, 'execution_state');
  assert.equal(failure.relevance, 0.5);
  assert.equal(failure.provenance.toolResult?.isError, true);
  assert.equal(
    projected.some(
      (item) => item.source.kind === 'tool' && item.source.toolCallId === 'planned-call',
    ),
    false,
  );
});

test('records bounded tool-result transformations without copying canonical content', () => {
  const originalFile = '0123456789'.repeat(100);
  const originalListing = 'total 48\n'.repeat(100);
  const canonicalMessages: AgentMessage[] = [
    call(
      'file-call-message',
      'file-call',
      'read_file',
      { path: 'docs/current/status.md' },
      '2026-01-01T00:00:01.000Z',
    ),
    result('file-result', 'file-call', originalFile, '2026-01-01T00:00:02.000Z'),
    call(
      'list-call-message',
      'list-call',
      'bash',
      { command: 'ls -la' },
      '2026-01-01T00:00:03.000Z',
    ),
    result('list-result', 'list-call', originalListing, '2026-01-01T00:00:04.000Z'),
  ];
  const messages = structuredClone(canonicalMessages);
  const fileResult = messages[1]?.content[0];
  const listResult = messages[3]?.content[0];
  assert.equal(fileResult?.type, 'tool_result');
  assert.equal(listResult?.type, 'tool_result');
  if (fileResult?.type === 'tool_result') fileResult.content = '012345...6789';
  if (listResult?.type === 'tool_result') {
    listResult.content =
      '[Identical to a later result of bash; the duplicate copy was removed to fit the context.]';
  }

  const projected = projectContextItems({ messages, canonicalMessages });
  const truncated = projected.find(
    (item) => item.source.kind === 'tool' && item.source.toolCallId === 'file-call',
  );
  const deduplicated = projected.find(
    (item) => item.source.kind === 'tool' && item.source.toolCallId === 'list-call',
  );

  assert.ok(truncated);
  assert.equal(truncated.type, 'file_content');
  assert.equal(truncated.content, '012345...6789');
  assert.equal(truncated.provenance.toolResult?.transformation, 'truncated');
  assert.equal(
    truncated.provenance.toolResult?.originalContentHash,
    createHash('sha256').update(originalFile).digest('hex'),
  );
  assert.equal(truncated.provenance.toolResult?.originalContentCharacters, originalFile.length);
  assert.equal(truncated.provenance.toolResult?.content.includes(originalFile), false);

  assert.ok(deduplicated);
  assert.equal(deduplicated.type, 'execution_state');
  assert.equal(deduplicated.provenance.toolResult?.transformation, 'deduplicated');
  assert.equal(
    deduplicated.provenance.toolResult?.originalContentHash,
    createHash('sha256').update(originalListing).digest('hex'),
  );
  assert.equal(
    deduplicated.provenance.toolResult?.originalContentCharacters,
    originalListing.length,
  );
});

test('does not project planned calls or orphan results as evidence', () => {
  const projected = projectContextItems({
    messages: [
      call(
        'planned',
        'planned-call',
        'web_search',
        { query: 'latest status' },
        '2026-01-01T00:00:01.000Z',
      ),
      result(
        'orphan',
        'missing-call',
        'synthetic result',
        '2026-01-01T00:00:02.000Z',
      ),
    ],
  });

  assert.deepEqual(projected, []);
});
