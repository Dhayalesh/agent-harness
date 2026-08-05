import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  AGENTCORE_SESSION_HEADER,
  RulePermissionHandler,
  SkillRegistry,
  startAgentCoreRuntime,
  type AgentRecord,
  type ModelProvider,
  type ModelProviderRecord,
  type ModelRequest,
  type ModelStreamEvent,
  type ResolvedAgent,
  type Tool,
} from '../../src/index.js';

const PROVIDER_ID = '6a67cb6e3c57852f5710071d';

function providerRecord(): ModelProviderRecord {
  const timestamp = new Date().toISOString();
  return {
    name: 'primary',
    provider: 'openai-compatible',
    model: 'zai.glm-5',
    baseURL: 'https://models.internal.example/v1',
    apiKey: 'test-key',
    auth: { kind: 'bearer' },
    capabilities: {
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      supportsTools: true,
      supportsStreaming: true,
      supportsReasoning: false,
      reportsCost: false,
    },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'operator',
  };
}

function agentRecord(name: string): AgentRecord {
  const timestamp = new Date().toISOString();
  return {
    name,
    systemPrompt: `You are ${name}.`,
    modelProviderId: PROVIDER_ID,
    tools: ['write_file'],
    skills: [],
    mcpServerIds: [],
    limits: { maxTurns: 4 },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'operator',
  };
}

/**
 * Stands in for the instance the registry would have taken from the host
 * catalogue. It must never run: the assembly is expected to swap it for the tool
 * bound to the session's own workspace, and a call landing here would mean it did
 * not.
 */
function unboundTool(name: string): Tool {
  return {
    name,
    description: `unbound ${name}`,
    inputSchema: z.unknown(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'write',
    concurrencySafe: false,
    async execute() {
      throw new Error(`${name} ran against the shared catalogue instead of the session workspace`);
    },
  };
}

/**
 * Asks for one write, then finishes once it sees the result.
 *
 * Stateless on purpose. `ScriptedModelProvider` advances a cursor held on the
 * instance, and a cached agent shares one provider with every session that names
 * it, so a scripted double would run out partway through the second session. Real
 * providers keep no position between calls — `service/index.ts` already shares one
 * across every session — so the double should not either. It decides from the
 * conversation it is handed instead.
 */
function writeOnceProvider(name: string, fileName: string): ModelProvider {
  return {
    name: 'write-once',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const done = request.messages
        .flatMap((message) => message.content)
        .some((block) => block.type === 'tool_result');
      const events: readonly ModelStreamEvent[] = done
        ? [
            { type: 'text_delta', delta: 'done' },
            { type: 'completed', stopReason: 'end_turn' },
          ]
        : [
            {
              type: 'tool_call',
              id: 'call-1',
              name: 'write_file',
              input: { path: fileName, content: `written by ${name}\n` },
            },
            { type: 'completed', stopReason: 'tool_use' },
          ];
      for (const event of events) yield event;
    },
  };
}

/** Writes one file into whatever workspace its session was given, then stops. */
function writingAgent(name: string, fileName: string): ResolvedAgent {
  const record = agentRecord(name);
  return {
    record,
    provider: writeOnceProvider(name, fileName),
    modelProvider: providerRecord(),
    systemPrompt: record.systemPrompt,
    skillRecords: [],
    skillDirectory: path.join(tmpdir(), 'unused-skills'),
    tools: [unboundTool('write_file')],
    skills: new SkillRegistry(),
    mcpConnections: [],
    mcpRecords: [],
    limits: { maxTurns: record.limits.maxTurns },
    async close() {},
  };
}

async function run(url: string, sessionId: string, body: unknown): Promise<void> {
  const response = await fetch(`${url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AGENTCORE_SESSION_HEADER]: sessionId },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  await response.text();
}

test('each session writes into its own workspace and agents resolve once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentcore-runtime-'));
  const resolved: string[] = [];
  const closed: string[] = [];
  const runtime = await startAgentCoreRuntime({
    workspace: path.join(root, 'workspace'),
    dataDirectory: path.join(root, 'data'),
    host: '127.0.0.1',
    port: 0,
    agentConfig: { uri: 'mongodb://unused/db', databaseName: 'unused' },
    shellEnvironment: {},
    createPermissionHandler: () => new RulePermissionHandler({ mode: 'bypass' }),
    agentCacheOptions: {
      defaultAgentName: async () => 'triage',
      resolve: async (agentName) => {
        resolved.push(agentName);
        const agent = writingAgent(agentName, 'marker.txt');
        return {
          ...agent,
          close: async () => {
            closed.push(agentName);
          },
        };
      },
    },
  });

  try {
    await run(runtime.url, 'session-one', { type: 'run', prompt: 'write', agentName: 'triage' });
    await run(runtime.url, 'session-two', { type: 'run', prompt: 'write', agentName: 'triage' });
    // No agentName, so the default is used. It names the same record, so the
    // assembled agent behind it is the one already resolved.
    await run(runtime.url, 'session-three', { type: 'run', prompt: 'write' });

    // Three sessions, three workspace directories, one resolution.
    const directories = (await readdir(path.join(root, 'workspace'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.equal(directories.length, 3, `expected three session workspaces, got ${directories}`);
    assert.deepEqual(resolved, ['triage']);

    // The write landed inside each session's own directory, which is the point:
    // one shared root would have produced a single file three sessions fought over.
    for (const directory of directories) {
      const written = await readFile(path.join(root, 'workspace', directory, 'marker.txt'), 'utf8');
      assert.equal(written, 'written by triage\n');
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }

  // Shutdown closes what the cache held, which is what releases MCP connections
  // and deletes the temporary skill directories.
  assert.deepEqual(closed, ['triage']);
});

test('a second agent resolves separately and a failed resolution is not cached', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentcore-runtime-'));
  const attempts: string[] = [];
  let failNext = true;
  const runtime = await startAgentCoreRuntime({
    workspace: path.join(root, 'workspace'),
    dataDirectory: path.join(root, 'data'),
    host: '127.0.0.1',
    port: 0,
    agentConfig: { uri: 'mongodb://unused/db', databaseName: 'unused' },
    shellEnvironment: {},
    createPermissionHandler: () => new RulePermissionHandler({ mode: 'bypass' }),
    agentCacheOptions: {
      defaultAgentName: async () => 'triage',
      resolve: async (agentName) => {
        attempts.push(agentName);
        if (agentName === 'flaky' && failNext) {
          failNext = false;
          throw new Error('model provider record is missing');
        }
        return writingAgent(agentName, 'marker.txt');
      },
    },
  });

  try {
    await run(runtime.url, 'session-a', { type: 'run', prompt: 'write', agentName: 'triage' });
    await run(runtime.url, 'session-b', { type: 'run', prompt: 'write', agentName: 'billing' });
    assert.deepEqual(attempts, ['triage', 'billing']);

    const failed = await fetch(`${runtime.url}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENTCORE_SESSION_HEADER]: 'session-c' },
      body: JSON.stringify({ type: 'run', prompt: 'write', agentName: 'flaky' }),
    });
    assert.equal(failed.status, 500);

    // Retried after the record was fixed rather than served the first failure
    // forever, which is why a rejected entry is evicted.
    await run(runtime.url, 'session-d', { type: 'run', prompt: 'write', agentName: 'flaky' });
    assert.deepEqual(attempts, ['triage', 'billing', 'flaky', 'flaky']);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
