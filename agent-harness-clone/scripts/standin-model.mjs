/**
 * A deterministic stand-in for a tool-calling model, speaking the OpenAI-compatible
 * streaming wire format. Used for end-to-end validation when no real model quota is
 * available. It is not a mock of the runtime: the harness, its HTTP server, SSE,
 * tools, context layer and retry provider all run for real against it.
 *
 * Every decision is derived from the conversation it is sent — the system prompt,
 * the user's request, and the actual tool results — so it only "sees" what the
 * runtime put in its context. That is what makes it useful: if the runtime failed
 * to isolate a child's context or to return a child's result, this model's next
 * step would visibly go wrong.
 *
 *   node scripts/standin-model.mjs [port]
 *
 * Behaviour, selected by the first user message:
 *   "architecture report"  parent: plan -> 3 parallel explore subagents -> synthesis
 *   "two dependent steps"  parent: wave 1 subagent -> wave 2 using wave 1's output
 *   "count exports"        runs a huge command, then greps the spilled file
 *   "read these files"     reads big files one by one (drives compaction)
 *   "keep going"           never stops calling tools (drives the step limit)
 *   "flaky"                first request per session returns 503 (drives retry)
 *   "stuck"                repeats an identical call (drives doom-loop guard)
 *   anything else          answers directly
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8791);
const seenSessions = new Set();
let requestCount = 0;

function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}
function textReply(text, usage) {
  return (
    frame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    frame({ usage })
  );
}
function toolReply(calls, text, usage) {
  return (
    (text ? frame({ choices: [{ delta: { content: text }, finish_reason: null }] }) : '') +
    frame({
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    }) +
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    frame({ usage })
  );
}

let idSeq = 0;
const id = (prefix) => `${prefix}_${++idSeq}`;

function decide(body) {
  const messages = body.messages ?? [];
  const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
  const firstUser = String(messages.find((m) => m.role === 'user')?.content ?? '');
  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  const lastUser = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  const tools = new Set((body.tools ?? []).map((t) => t.function.name));
  const isChild = system.includes('You are a subagent');
  const chars = JSON.stringify(messages).length;
  const usage = { prompt_tokens: Math.ceil(chars / 3.2), completion_tokens: 60 };

  // The runtime's wrap-up turn withdraws every tool.
  if (lastUser.includes('MAXIMUM STEPS REACHED') || tools.size === 0) {
    return textReply(
      `The step limit was reached. Completed: ${toolResults.length} tool steps. Remaining: the rest of the files were not summarised. Next: continue in a new turn, or delegate the remaining files to subagents.`,
      usage,
    );
  }

  if (isChild) {
    // An explore child: search its area, read one file, report.
    const area = /area (src\/[a-z]+)/.exec(firstUser)?.[1] ?? 'src';
    if (firstUser.includes('write ')) {
      const target = /write (\S+)/.exec(firstUser)?.[1];
      const content = /CONTENT<<(.*)>>CONTENT/s.exec(firstUser)?.[1] ?? '';
      if (toolResults.length === 0) {
        return toolReply(
          [{ id: id('w'), name: 'write_file', args: { path: target, content } }],
          '',
          usage,
        );
      }
      return textReply(
        `Wrote ${target} (${content.length} chars). Verified by write_file success.`,
        usage,
      );
    }
    if (toolResults.length === 0) {
      return toolReply(
        [{ id: id('g'), name: 'glob', args: { pattern: `${area}/**/*.ts` } }],
        '',
        usage,
      );
    }
    if (toolResults.length === 1) {
      const files = toolResults[0].split('\n').filter((line) => line.endsWith('.ts'));
      const first = files[0] ?? `${area}/index.ts`;
      return toolReply(
        [{ id: id('r'), name: 'read_file', args: { path: first, limit: 40 } }],
        '',
        usage,
      );
    }
    const files = toolResults[0].split('\n').filter((line) => line.endsWith('.ts'));
    const exported = (toolResults[1].match(/export (?:function|class|const|type) (\w+)/g) ?? [])
      .slice(0, 4)
      .map((s) => s.split(' ').pop());
    return textReply(
      `${area}: ${files.length} TypeScript files. Examined ${files[0] ?? '(none)'}; its exports include ${exported.join(', ') || '(none found in the first 40 lines)'}.`,
      usage,
    );
  }

  if (firstUser.includes('architecture report')) {
    if (!messages.some((m) => m.role === 'assistant')) {
      return toolReply(
        [
          {
            id: id('plan'),
            name: 'todo_write',
            args: {
              todos: [
                {
                  content: 'Research src/core, src/context and src/tools in parallel',
                  status: 'in_progress',
                  activeForm: 'Researching the three areas in parallel',
                },
                {
                  content: 'Write the combined report',
                  status: 'pending',
                  activeForm: 'Writing the combined report',
                },
              ],
            },
          },
        ],
        'I will plan this, then research the three independent areas in parallel.',
        usage,
      );
    }
    const taskResults = toolResults.filter((r) => r.includes('<task_result>'));
    if (taskResults.length === 0) {
      return toolReply(
        ['src/core', 'src/context', 'src/tools'].map((area) => ({
          id: id('task'),
          name: 'task',
          args: {
            description: `Explore ${area}`,
            subagent_type: 'explore',
            prompt: `Research the area ${area} of this repository. Find its TypeScript files, examine the main one, and report the file count and main exports. Do not modify files.`,
          },
        })),
        '',
        usage,
      );
    }
    if (!toolResults.some((r) => r.includes('Write the combined report') && r.includes('[~]'))) {
      return toolReply(
        [
          {
            id: id('plan'),
            name: 'todo_write',
            args: {
              todos: [
                {
                  content: 'Research src/core, src/context and src/tools in parallel',
                  status: 'completed',
                  activeForm: 'Researching',
                },
                {
                  content: 'Write the combined report',
                  status: 'in_progress',
                  activeForm: 'Writing the combined report',
                },
              ],
            },
          },
        ],
        '',
        usage,
      );
    }
    const findings = taskResults.map(
      (r) => /<task_result>\n([\s\S]*?)\n<\/task_result>/.exec(r)?.[1] ?? '',
    );
    return textReply(
      `# Architecture report\n\n${findings.map((f) => `- ${f}`).join('\n')}\n\nAll three areas were researched in parallel by separate subagents; only their conclusions entered this context.`,
      usage,
    );
  }

  if (firstUser.includes('two dependent steps')) {
    const taskResults = toolResults.filter((r) => r.includes('<task_result>'));
    if (taskResults.length === 0) {
      return toolReply(
        [
          {
            id: id('task'),
            name: 'task',
            args: {
              description: 'Write API contract',
              subagent_type: 'general',
              prompt:
                'write out/api.json CONTENT<<{"endpoint":"/v1/items","fields":["id","name","price"]}>>CONTENT',
            },
          },
        ],
        'Wave 1: the API contract. The client depends on it, so it runs first.',
        usage,
      );
    }
    // Between the waves: read what wave 1 actually produced on disk.
    const contract = toolResults.find(
      (r) => r.includes('/v1/items') && !r.includes('<task_result>'),
    );
    if (taskResults.length === 1 && !contract) {
      return toolReply(
        [{ id: id('r'), name: 'read_file', args: { path: 'out/api.json' } }],
        '',
        usage,
      );
    }
    if (taskResults.length === 1) {
      const parsed = JSON.parse(contract.replace(/^\s*\d+\t/gm, ''));
      const client = `export type Item = { ${parsed.fields.map((f) => `${f}: ${f === 'price' ? 'number' : 'string'}`).join('; ')} };\nexport async function fetchItems(): Promise<Item[]> {\n  const response = await fetch('${parsed.endpoint}');\n  return (await response.json()) as Item[];\n}\n`;
      return toolReply(
        [
          {
            id: id('task'),
            name: 'task',
            args: {
              description: 'Write typed client',
              subagent_type: 'general',
              prompt: `write out/client.ts CONTENT<<${client}>>CONTENT`,
            },
          },
        ],
        `Wave 2: the client, built from wave 1's contract (${parsed.endpoint}).`,
        usage,
      );
    }
    return textReply(
      'Both waves completed: out/api.json defines /v1/items and out/client.ts was generated from it.',
      usage,
    );
  }

  if (firstUser.includes('count exports')) {
    if (toolResults.length === 0) {
      return toolReply(
        [
          {
            id: id('sh'),
            name: 'powershell',
            args: { command: 'Get-ChildItem -Recurse src -Filter *.ts | Get-Content' },
          },
        ],
        '',
        usage,
      );
    }
    if (toolResults.length === 1) {
      const saved = /saved at (\S+)\./.exec(toolResults[0])?.[1];
      if (!saved)
        return textReply(`The output fit inline (${toolResults[0].length} chars).`, usage);
      return toolReply(
        [
          {
            id: id('gr'),
            name: 'grep',
            args: { query: 'export ', path: saved, maxResults: 10000 },
          },
        ],
        `The output was saved to ${saved}; searching it.`,
        usage,
      );
    }
    const lines = toolResults[1].split('\n').filter((l) => l.includes('export ')).length;
    return textReply(
      `Found ${lines} lines containing "export " in the saved output, without loading all of it into context.`,
      usage,
    );
  }

  if (firstUser.includes('read these files')) {
    const files = [
      'src/core/agent-session.ts',
      'src/context/context-orchestrator.ts',
      'src/context/context-manager.ts',
      'src/headless/invoke.ts',
      'src/context/context-state.ts',
    ];
    // Progress comes from the notes this "model" wrote after each file, the way a
    // real model relies on its own prior text and the compaction summary. Tool-call
    // messages are legitimately dropped by compaction; if the notes were lost too,
    // this would re-read files — which is exactly the continuity being tested.
    const context = JSON.stringify(messages.slice(1));
    const noted = files.filter((file) => context.includes(`Noted ${file}`)).length;
    const pendingResult = messages.at(-1)?.role === 'tool';
    const done = noted + (pendingResult ? 1 : 0);
    const note = pendingResult ? `Noted ${files[done - 1]}.` : '';
    if (done < files.length) {
      return toolReply(
        [{ id: id('rd'), name: 'read_file', args: { path: files[done] } }],
        note,
        usage,
      );
    }
    return textReply(
      `${note}\nRead all ${files.length} files in order, each once; progress carried across compaction.`,
      usage,
    );
  }

  if (firstUser.includes('keep going')) {
    const n = toolResults.length;
    return toolReply([{ id: id('g'), name: 'glob', args: { pattern: `src/*${n}*` } }], '', usage);
  }

  if (firstUser.includes('stuck')) {
    if (toolResults.some((r) => r.includes('Change approach'))) {
      return textReply(
        'The repeated search was stopped by the runtime; switching approach: the file does not exist.',
        usage,
      );
    }
    return toolReply(
      [{ id: id('st'), name: 'grep', args: { query: 'definitely-not-present-xyz' } }],
      '',
      usage,
    );
  }

  return textReply(`Answer: ${firstUser.slice(0, 80)}`, usage);
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requestCount += 1;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400).end('bad json');
      return;
    }
    const firstUser = String(body.messages?.find((m) => m.role === 'user')?.content ?? '');
    if (firstUser.includes('flaky') && !seenSessions.has(firstUser)) {
      seenSessions.add(firstUser);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'temporarily overloaded' } }));
      return;
    }
    // A little latency, so parallel work is visibly parallel.
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${decide(body)}data: [DONE]\n\n`);
    }, 150);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`stand-in model on http://127.0.0.1:${port}/v1`);
});
