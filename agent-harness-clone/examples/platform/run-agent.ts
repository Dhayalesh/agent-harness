const baseUrl = process.env.PLATFORM_URL ?? 'http://127.0.0.1:8788';
const apiKey = requiredEnvironment('PLATFORM_API_KEY');
const agent = requiredEnvironment('PLATFORM_AGENT');
const prompt = process.argv.slice(2).join(' ').trim() || 'Explain what you can do in one sentence.';
const permissionDecision = process.env.PLATFORM_PERMISSION_DECISION === 'allow' ? 'allow' : 'deny';
const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};

const handle = await json<{ sessionId: string; controlToken: string }>(
  `${baseUrl}/v1/agents/${encodeURIComponent(agent)}/sessions`,
  { method: 'POST', headers, body: JSON.stringify({ environment: 'production' }) },
);
const runId = crypto.randomUUID();
const controlHeaders = { ...headers, 'x-agent-control-token': handle.controlToken };
const response = await fetch(`${baseUrl}/v1/sessions/${handle.sessionId}/runs`, {
  method: 'POST',
  headers: controlHeaders,
  body: JSON.stringify({ prompt, runId }),
});
if (!response.ok || !response.body) {
  throw new Error(`Run failed (${response.status}): ${await response.text()}`);
}

for await (const event of readSse(response.body)) {
  if (event.type === 'assistant.text.delta' && typeof event.delta === 'string') {
    process.stdout.write(event.delta);
  }
  if (event.type === 'permission.requested' && typeof event.requestId === 'string') {
    await json(
      `${baseUrl}/v1/sessions/${handle.sessionId}/permissions/${encodeURIComponent(event.requestId)}`,
      {
        method: 'POST',
        headers: controlHeaders,
        body: JSON.stringify({ decision: permissionDecision }),
      },
    );
  }
  if (event.type === 'error') process.stderr.write(`\n${String(event.message)}\n`);
}
process.stdout.write(`\n\nsession=${handle.sessionId} run=${runId}\n`);

async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      if (data) yield JSON.parse(data) as Record<string, unknown>;
    }
    if (done) return;
  }
}

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
