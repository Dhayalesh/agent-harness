import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../src/index.js';

const baseUrl = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:8787';
const serviceKey = process.env.AGENT_SERVICE_KEY;
const commonHeaders: Record<string, string> = {
  'x-agent-owner': process.env.AGENT_OWNER ?? 'demo-client',
  ...(serviceKey === undefined ? {} : { 'x-agent-service-key': serviceKey }),
};

const health = await requestJson<{ status: string; protocolVersion: number }>(`${baseUrl}/health`);
process.stdout.write(`health: ${health.status}, protocol v${health.protocolVersion}\n`);

const created = await requestJson<{ sessionId: string; controlToken: string }>(
  `${baseUrl}/sessions`,
  { method: 'POST', headers: commonHeaders },
);
process.stdout.write(`session: ${created.sessionId}\n`);

const response = await fetch(`${baseUrl}/sessions/${created.sessionId}/runs`, {
  method: 'POST',
  headers: {
    ...commonHeaders,
    authorization: `Bearer ${created.controlToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    prompt: process.argv.slice(2).join(' ') || 'Demonstrate the standalone agent-core API',
    runId: randomUUID(),
  }),
});
if (!response.ok || !response.body) {
  throw new Error(`Run failed (${response.status}): ${await response.text()}`);
}

let finalText = '';
for await (const event of readSseEvents(response.body)) {
  process.stdout.write(`event: ${event.type}\n`);
  if (event.type === 'assistant.text.delta') finalText += event.delta;
  if (event.type === 'permission.requested') {
    process.stdout.write(`permission: allowing ${event.toolName}\n`);
    await requestJson(`${baseUrl}/sessions/${created.sessionId}/permissions/${event.requestId}`, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        authorization: `Bearer ${created.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'allow' }),
    });
  }
}

const replay = await requestJson<AgentEvent[]>(
  `${baseUrl}/sessions/${created.sessionId}/events?after=0`,
  { headers: commonHeaders },
);
process.stdout.write(`answer: ${finalText}\n`);
process.stdout.write(`replayed events: ${replay.length}\n`);

await requestJson(`${baseUrl}/sessions/${created.sessionId}`, {
  method: 'DELETE',
  headers: {
    ...commonHeaders,
    authorization: `Bearer ${created.controlToken}`,
  },
});
process.stdout.write('session closed\n');

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data) as AgentEvent;
    }
    if (done) break;
  }
}
