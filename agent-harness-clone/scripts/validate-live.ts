/**
 * Live validation: runs representative tasks through `streamHeadless` against the
 * model in payload.json and prints an operational trace. Not part of the test suite
 * (it needs a real credential and spends tokens).
 *
 *   npx tsx scripts/validate-live.ts <scenario> <workingDirectory>
 */
import { readFile } from 'node:fs/promises';
import { streamHeadless, type AgentEvent } from '../src/index.js';

const [scenario = 'small', workingDirectory = process.cwd()] = process.argv.slice(2);
const base = JSON.parse(await readFile(new URL('../payload.json', import.meta.url), 'utf8'));
// STANDIN_MODEL_URL points the run at scripts/standin-model.mjs instead of the real model.
if (process.env.STANDIN_MODEL_URL) {
  base.modelProvider = {
    ...base.modelProvider,
    name: 'standin',
    model: 'standin',
    baseURL: process.env.STANDIN_MODEL_URL,
    apiKey: 'standin',
  };
}

const scenarios: Record<
  string,
  {
    prompt: string;
    tools: string[];
    maxTurns: number;
    orchestration?: object;
    threshold?: number;
    contextWindow?: number;
  }
> = {
  flaky: { prompt: 'flaky: say hello', tools: ['read_file'], maxTurns: 3 },
  stuck: { prompt: 'stuck: find the helper', tools: ['grep', 'read_file'], maxTurns: 8 },
  small: {
    prompt: 'What is the name of the package in package.json? Answer in one sentence.',
    tools: ['read_file', 'glob', 'grep'],
    maxTurns: 6,
  },
  parallel: {
    prompt:
      'Produce a short architecture report of this repository. Its three top-level areas — src/core, src/context and src/tools — are independent, so research each one in parallel with a separate explore subagent (one task call per area, all in the same message). Then combine the findings into a report with one short section per area. Do not modify any files.',
    tools: ['read_file', 'glob', 'grep', 'todo_write'],
    maxTurns: 10,
    orchestration: { subagents: true, maxConcurrent: 3, subagentMaxTurns: 12 },
  },
  dependent: {
    prompt:
      'two dependent steps: In the directory out/, do two steps that depend on each other. Step 1: delegate to a general subagent to write out/api.json containing a JSON object {"endpoint": "/v1/items", "fields": ["id","name","price"]}. Step 2: only after step 1 has finished, delegate to another general subagent, giving it the exact contents of out/api.json from step 1, to write out/client.ts exporting an async function fetchItems() that calls that endpoint and a TypeScript Item type with those fields. Finally read both files and confirm they agree.',
    tools: ['read_file', 'write_file', 'glob', 'todo_write'],
    maxTurns: 10,
    orchestration: { subagents: true, maxConcurrent: 2, subagentMaxTurns: 8 },
  },
  bigoutput: {
    prompt:
      'count exports: Run the shell command that prints every line of every .ts file under src concatenated (on Windows use powershell: Get-ChildItem -Recurse src -Filter *.ts | Get-Content). Then tell me how many times the word "export" appears in that output, using the saved full output rather than guessing.',
    tools: ['powershell', 'bash', 'read_file', 'grep'],
    maxTurns: 8,
  },
  compaction: {
    prompt:
      'read these files: Read these files in full, one at a time, and after each one note its main export: src/core/agent-session.ts, src/context/context-orchestrator.ts, src/context/context-manager.ts, src/headless/invoke.ts, src/context/context-state.ts. Then list all five main exports.',
    tools: ['read_file'],
    maxTurns: 12,
    threshold: 30,
    contextWindow: 30_000,
  },
  turnlimit: {
    prompt:
      'keep going: List every .ts file under src, then read each one of them and summarise it, one file per step.',
    tools: ['read_file', 'glob'],
    maxTurns: 3,
  },
};

const chosen = scenarios[scenario];
if (!chosen) throw new Error(`Unknown scenario ${scenario}`);
const payload = {
  ...base,
  prompt: chosen.prompt,
  workingDirectory,
  agent: {
    ...base.agent,
    tools: chosen.tools,
    limits: {
      maxTurns: chosen.maxTurns,
      maxOutputTokens: 8_000,
      ...(chosen.threshold ? { compactionThresholdPercent: chosen.threshold } : {}),
    },
  },
  modelProvider: {
    ...base.modelProvider,
    ...(chosen.contextWindow
      ? {
          capabilities: {
            ...base.modelProvider.capabilities,
            contextWindow: chosen.contextWindow,
            maxOutputTokens: 8_000,
          },
        }
      : {}),
  },
  permissionRules: [...chosen.tools, 'task'].map((tool) => ({ tool, decision: 'allow' })),
  permissionFallback: 'deny',
  skills: [],
  mcpServers: [],
  ...(chosen.orchestration ? { orchestration: chosen.orchestration } : {}),
};

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
let text = '';
const counts: Record<string, number> = {};
for await (const event of streamHeadless(payload) as AsyncIterable<AgentEvent>) {
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  switch (event.type) {
    case 'turn.started':
      console.log(t(), `turn ${event.turn}`);
      break;
    case 'tool.started':
      console.log(
        t(),
        `  tool ${event.call.name} ${JSON.stringify(event.call.input).slice(0, 110)}`,
      );
      break;
    case 'tool.completed':
      console.log(
        t(),
        `  done ${event.result.isError ? 'ERROR ' : ''}${event.result.content.length} chars${event.result.metadata?.spilledTo ? ` spilled->${event.result.metadata.spilledTo}` : ''}`,
      );
      break;
    case 'subagent.started':
      console.log(
        t(),
        `  ▶ subagent ${event.agentType} "${event.description}" ${event.taskId}${event.resumed ? ' (resumed)' : ''}`,
      );
      break;
    case 'subagent.progress':
      if (event.kind !== 'tool.completed')
        console.log(
          t(),
          `    · [${event.taskId.slice(-8)}] ${event.kind}: ${event.message.slice(0, 90)}`,
        );
      break;
    case 'subagent.completed':
      console.log(
        t(),
        `  ■ subagent ${event.taskId.slice(-8)} ${event.status} turns=${event.turns} tools=${event.toolCalls} ${event.durationMs}ms :: ${event.summary.slice(0, 120).replace(/\n/g, ' ')}`,
      );
      break;
    case 'plan.updated':
      console.log(
        t(),
        `  plan (${event.owner}): ${event.todos
          .map((x) => `[${x.status[0]}] ${x.content}`)
          .join(' | ')
          .slice(0, 200)}`,
      );
      break;
    case 'agent.intervention':
      console.log(t(), `  ! intervention ${event.kind}: ${event.message}`);
      break;
    case 'context.usage':
      console.log(
        t(),
        `  ctx ${event.usedPercent}% of ${event.budgetTokens}${event.peakPercent ? ` peak ${event.peakPercent}%` : ''} action=${event.action ?? '-'}${event.compacted ? ' COMPACTED' : ''}`,
      );
      break;
    case 'context.compaction.completed':
      console.log(t(), `  compaction ${event.tokensBefore} -> ${event.tokensAfter}`);
      break;
    case 'warning':
      console.log(t(), `  warning ${event.code}: ${event.message.slice(0, 140)}`);
      break;
    case 'error':
      console.log(t(), `  ERROR ${event.code}: ${event.message}`);
      break;
    case 'assistant.text.delta':
      text += event.delta;
      break;
    case 'assistant.message.completed':
      text += '\n';
      break;
    case 'session.completed':
      console.log(t(), `session completed: ${event.reason}`);
      break;
  }
}
console.log('\n--- final text (tail) ---\n' + text.trim().slice(-1500));
console.log('\n--- event counts ---\n' + JSON.stringify(counts));
