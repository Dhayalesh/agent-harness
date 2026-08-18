import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAttachments } from '../../src/files/attachments.js';
import { estimateMessagesTokens } from '../../src/context/context-manager.js';
import { invocationAttachmentSchema, invocationPayloadSchema } from '../../src/headless/payload.js';
import { OpenAICompatibleModelProvider } from '../../src/models/openai-compatible-provider.js';
import type { AgentMessage } from '../../src/core/messages.js';
import type { ModelRequest } from '../../src/models/provider.js';

function textAttachment(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'text' as const,
    filename: 'notes.md',
    contentType: 'text/markdown',
    text: 'Hello',
    ...overrides,
  };
}

test('a text attachment is fenced and labelled ahead of the prompt', () => {
  const prepared = prepareAttachments(
    [textAttachment({ language: 'markdown', size: 5, notes: ['truncated'] })],
    'Summarise this',
  );

  assert.equal(prepared.images.length, 0);
  assert.equal(
    prepared.prompt,
    '<attached_files>\n' +
      '<file name="notes.md" type="text/markdown" language="markdown" note="truncated">\n' +
      '```\nHello\n```\n' +
      '</file>\n' +
      '</attached_files>\n\n' +
      'Summarise this',
  );
  assert.deepEqual(prepared.summary, ['notes.md (text/markdown, text, 5 bytes)']);
});

test('the fence outgrows backticks inside the file so content cannot escape it', () => {
  const prepared = prepareAttachments(
    [textAttachment({ text: 'before\n```\ncode\n```\nafter' })],
    'Review',
  );

  // A three-backtick fence would have been closed by the file's own fence, spilling
  // the rest of the upload into the prompt as if the user had written it.
  assert.match(prepared.prompt, /````\nbefore\n```\ncode\n```\nafter\n````/);
});

test('a quote or control character in a filename cannot break out of the attribute', () => {
  const prepared = prepareAttachments([textAttachment({ filename: 'we"ird\u0007.md' })], 'Read it');

  assert.match(prepared.prompt, /name="we'ird .md"/);
});

test('an image becomes a block and is still named in the prompt', () => {
  const prepared = prepareAttachments(
    [
      {
        kind: 'image',
        filename: 'chart.png',
        contentType: 'image/png',
        data: 'AAAA',
      },
    ],
    'What does this show?',
  );

  assert.deepEqual(prepared.images, [
    { type: 'image', mediaType: 'image/png', data: 'AAAA', filename: 'chart.png' },
  ]);
  // Named as well as sent, so "the second screenshot" can be resolved by the model.
  assert.match(prepared.prompt, /<image name="chart.png" \/>/);
  assert.match(prepared.prompt, /What does this show\?$/);
});

test('files sent with no message still produce an instruction', () => {
  const prepared = prepareAttachments([textAttachment()], '   ');

  assert.ok(prepared.prompt.trim().length > 0);
  assert.match(prepared.prompt, /no message/i);
});

test('a payload with no attachments is passed through untouched', () => {
  const prepared = prepareAttachments([], 'Just a question');

  assert.equal(prepared.prompt, 'Just a question');
  assert.deepEqual(prepared.images, []);
  assert.deepEqual(prepared.summary, []);
});

test('attachment validation requires the content its kind implies', () => {
  assert.equal(invocationAttachmentSchema.safeParse(textAttachment()).success, true);
  assert.equal(
    invocationAttachmentSchema.safeParse({ ...textAttachment(), text: undefined }).success,
    false,
  );
  assert.equal(
    invocationAttachmentSchema.safeParse({
      kind: 'image',
      filename: 'a.png',
      contentType: 'image/png',
    }).success,
    false,
  );
  // An image content type is required, or a text file would be sent as an image.
  assert.equal(
    invocationAttachmentSchema.safeParse({
      kind: 'image',
      filename: 'a.png',
      contentType: 'text/plain',
      data: 'AAAA',
    }).success,
    false,
  );
  assert.equal(
    invocationAttachmentSchema.safeParse({ ...textAttachment(), extra: 1 }).success,
    false,
  );
});

test('a payload needs a prompt or an attachment, and accepts either alone', () => {
  const base = {
    agent: { name: 'A', systemPrompt: 'S' },
    modelProvider: {
      name: 'P',
      provider: 'openai-compatible',
      model: 'm',
      baseURL: 'https://example.com/v1',
      apiKey: 'k',
    },
  };

  assert.equal(invocationPayloadSchema.safeParse({ ...base, prompt: 'hi' }).success, true);
  assert.equal(
    invocationPayloadSchema.safeParse({
      ...base,
      prompt: '',
      attachments: [textAttachment()],
    }).success,
    true,
  );
  assert.equal(invocationPayloadSchema.safeParse({ ...base, prompt: '   ' }).success, false);
});

test('an image is costed as a flat charge, not by its base64 length', () => {
  const withoutImage: AgentMessage[] = [
    {
      id: 'a',
      role: 'user',
      createdAt: '2026-08-18T00:00:00.000Z',
      content: [{ type: 'text', text: 'hello' }],
    },
  ];
  const withImage: AgentMessage[] = [
    {
      id: 'a',
      role: 'user',
      createdAt: '2026-08-18T00:00:00.000Z',
      content: [
        // A megabyte of base64 would read as hundreds of thousands of tokens if the
        // character heuristic saw it, and would be compacted away every turn.
        { type: 'image', mediaType: 'image/png', data: 'A'.repeat(1_000_000) },
        { type: 'text', text: 'hello' },
      ],
    },
  ];

  const base = estimateMessagesTokens(withoutImage);
  const withOne = estimateMessagesTokens(withImage);
  assert.ok(withOne > base, 'an image should cost something');
  assert.ok(withOne < base + 2_000, `expected a flat charge, got ${withOne - base}`);
});

test('images travel to the provider as inline data URLs beside the text', async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAICompatibleModelProvider({
    apiKey: 'k',
    baseURL: 'https://compatible.example/v1',
    defaultModel: 'test/model',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const request: ModelRequest = {
    messages: [
      {
        id: 'u',
        role: 'user',
        createdAt: '2026-08-18T00:00:00.000Z',
        content: [
          { type: 'image', mediaType: 'image/png', data: 'AAAA', filename: 'chart.png' },
          { type: 'text', text: 'Explain' },
        ],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
  };
  for await (const _event of provider.stream(request)) {
    // Consume.
  }

  assert.deepEqual((body.messages as unknown[])[0], {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'Explain' },
    ],
  });
});

test('a text-only turn still sends a plain string, which every gateway accepts', async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAICompatibleModelProvider({
    apiKey: 'k',
    baseURL: 'https://compatible.example/v1',
    defaultModel: 'test/model',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  for await (const _event of provider.stream({
    messages: [
      {
        id: 'u',
        role: 'user',
        createdAt: '2026-08-18T00:00:00.000Z',
        content: [{ type: 'text', text: 'Just words' }],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
  })) {
    // Consume.
  }

  assert.deepEqual((body.messages as unknown[])[0], { role: 'user', content: 'Just words' });
});
