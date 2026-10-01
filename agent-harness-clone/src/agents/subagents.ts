import { z } from 'zod';
import { AgentHarnessError, errorMessage } from '../core/errors.js';
import type { AgentEvent, EventPayload } from '../core/events.js';
import type { ModelUsage } from '../models/provider.js';
import type { Tool, ToolExecutionContext } from '../tools/tool.js';

/**
 * Delegation to child agents.
 *
 * Modelled on CodeGenie's `task` tool (`packages/opencode/src/tool/task.ts`), whose
 * behaviour this reproduces rather than its code:
 *
 * - The *model* decides when work splits. There is no planner or DAG scheduler in
 *   the runtime: independent pieces are delegated as several `task` calls in one
 *   message and run concurrently; work that depends on an earlier result is
 *   delegated on a later turn, after the model has read that result. CodeGenie's
 *   orchestrator prompt calls these "waves", and the guidance for them lives in
 *   this tool's description.
 * - Every child starts with a fresh context holding only the prompt it was given,
 *   so a broad investigation never lands in the parent's window — only the child's
 *   final answer does.
 * - Delegation is one level deep. A child is never offered `task`, which is what
 *   keeps a runaway fan-out bounded.
 * - A child can be resumed by `task_id` to continue with its previous history.
 *
 * What is added for a hosted runtime: a concurrency cap (CodeGenie runs every call
 * in a message at once, which is fine on a laptop and not on a shared replica),
 * and resumption through the session store, so a child survives a replica hop.
 */

export type SubagentType = {
  name: string;
  /** Shown to the model in the tool description; says when to pick this type. */
  description: string;
  /** Instructions the child runs under. */
  systemPrompt: string;
  /**
   * Which of the parent's tools the child may use. `'inherit'` offers everything
   * the parent has except the tools no child ever gets (see `CHILD_EXCLUDED_TOOLS`).
   */
  tools: 'inherit' | readonly string[];
  /** Also prepend the parent's own system prompt, so domain rules carry over. */
  inheritSystemPrompt?: boolean;
  maxTurns?: number;
};

/**
 * Tools a child never gets, whatever its type.
 *
 * `task` because delegation is one level deep. `todo_write` because the plan the
 * user sees belongs to the agent they are talking to — CodeGenie denies it to
 * subagents for the same reason. The response-artifact tools because a document is
 * presented by the parent; a child's artifact would never reach the user.
 */
export const CHILD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'task',
  'todo_write',
  'create_markdown_artifact',
  'create_html_artifact',
  'create_document_artifact',
  'create_spreadsheet_artifact',
  'create_csv_artifact',
  'create_json_artifact',
  'create_code_artifact',
]);

const RETURN_CONTRACT = `You are a subagent working on one delegated piece of a larger task. Work autonomously; there is no user to ask. When you are done, your final message is the only thing returned to the agent that delegated to you, so make it self-contained: what you found or changed, exact file paths, anything that failed, and anything left undone. Do not ask follow-up questions.`;

export const DEFAULT_SUBAGENT_TYPES: readonly SubagentType[] = [
  {
    name: 'explore',
    description:
      'Fast read-only agent for exploring a codebase or workspace: finding files by pattern, searching code for keywords, answering "how does X work" questions. Specify the thoroughness you want: "quick", "medium", or "very thorough".',
    systemPrompt: `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Use glob for broad file pattern matching and grep for searching file contents.
- Use read_file when you know the specific path you need, with offset and limit for large files.
- Adapt how far you search to the thoroughness level the caller asked for.
- Report file paths exactly as they appear in the workspace.
- Do not create or modify files, and do not run commands that change the system.

${RETURN_CONTRACT}`,
    tools: ['read_file', 'glob', 'grep', 'bash', 'powershell', 'web_fetch', 'web_search'],
  },
  {
    name: 'general',
    description:
      'General-purpose agent for researching complex questions and executing multi-step work, including making changes. Use it to run several independent units of work in parallel.',
    systemPrompt: RETURN_CONTRACT,
    tools: 'inherit',
    inheritSystemPrompt: true,
  },
];

/** What a child needs from the host that created the parent. */
export type SubagentSession = {
  readonly id: string;
  run(input: { prompt: string }): AsyncIterable<AgentEvent>;
  interrupt(reason?: string): void;
  respondToPermission(requestId: string, decision: 'allow' | 'deny'): boolean;
};

export type SubagentSpawnSpec = {
  taskId: string;
  type: SubagentType;
  /** The parent tools this child may use, already filtered. */
  tools: readonly Tool[];
};

export type SubagentHost = {
  parentSessionId: string;
  /** The parent's tools, from which each child's set is filtered. */
  tools(): readonly Tool[];
  spawn(spec: SubagentSpawnSpec): SubagentSession;
  /** Reload a child from durable storage, for a `task_id` this process never saw. */
  resume?(spec: SubagentSpawnSpec): Promise<SubagentSession | undefined>;
  newId(): string;
  /**
   * The children this parent has started, shared with the host so a permission
   * answer addressed to a child can be routed to it (`routeChildPermission`).
   */
  children: Map<string, { session: SubagentSession; type: SubagentType }>;
};

/** Offer a permission answer to every live child; true when one owned it. */
export function routeChildPermission(
  children: SubagentHost['children'],
  requestId: string,
  decision: 'allow' | 'deny',
): boolean {
  for (const child of children.values()) {
    if (child.session.respondToPermission(requestId, decision)) return true;
  }
  return false;
}

export type TaskToolOptions = {
  types?: readonly SubagentType[];
  /**
   * How many children may run at once across the parent. Calls beyond this wait
   * for a slot rather than failing, so the model can issue a wide wave safely.
   */
  maxConcurrent?: number;
};

const SUMMARY_PREVIEW_CHARS = 600;

export function createTaskTool(host: SubagentHost, options: TaskToolOptions = {}): Tool {
  return buildTaskTool(host, options) as unknown as Tool;
}

function buildTaskTool(host: SubagentHost, options: TaskToolOptions) {
  const types = options.types ?? DEFAULT_SUBAGENT_TYPES;
  const byName = new Map(types.map((type) => [type.name, type]));
  const slots = new Semaphore(Math.max(1, options.maxConcurrent ?? 4));
  const children = host.children;

  const schema = z.object({
    description: z.string().min(1).max(120),
    prompt: z.string().min(1),
    subagent_type: z.string().min(1),
    task_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  });

  const childTools = (type: SubagentType): Tool[] => {
    const available = host.tools().filter((tool) => !CHILD_EXCLUDED_TOOLS.has(tool.name));
    if (type.tools === 'inherit') return available;
    const allowed = new Set(type.tools);
    return available.filter((tool) => allowed.has(tool.name));
  };

  const tool: Tool<z.infer<typeof schema>> = {
    name: 'task',
    description: taskDescription(types),
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 words) description of the task' },
        prompt: {
          type: 'string',
          description:
            'The complete, self-contained task for the agent: goal, relevant paths and results from earlier work, constraints, how to verify, and exactly what to report back',
        },
        subagent_type: {
          type: 'string',
          enum: types.map((type) => type.name),
          description: 'The type of specialised agent to use',
        },
        task_id: {
          type: 'string',
          description:
            'Only to resume a previous task: pass the task_id it returned to continue the same agent with its earlier history instead of starting fresh',
        },
      },
      required: ['description', 'prompt', 'subagent_type'],
      additionalProperties: false,
    },
    kind: 'execute',
    // Several `task` calls in one message are the parallel wave; the semaphore, not
    // the session, is what bounds them.
    concurrencySafe: true,
    checkPermissions() {
      // The child's own tool calls are each checked by the same handler, so
      // delegating grants nothing the parent could not already do.
      return { decision: 'allow', reason: 'Delegation; each child tool call is checked itself' };
    },
    async execute(input, context) {
      const type = byName.get(input.subagent_type);
      if (!type) {
        throw new AgentHarnessError(
          `Unknown subagent_type "${input.subagent_type}". Available: ${types.map((t) => t.name).join(', ')}`,
          'UNKNOWN_SUBAGENT_TYPE',
        );
      }

      let resumed = false;
      let child: SubagentSession | undefined;
      let taskId = input.task_id;
      if (taskId !== undefined) {
        const known = children.get(taskId);
        if (known) {
          child = known.session;
          resumed = true;
        } else if (host.resume) {
          child = await host.resume({ taskId, type, tools: childTools(type) });
          if (child) {
            children.set(taskId, { session: child, type });
            resumed = true;
          }
        }
        if (!child) {
          throw new AgentHarnessError(
            `No task found with task_id ${taskId}; omit task_id to start a new one`,
            'TASK_NOT_FOUND',
          );
        }
      } else {
        taskId = `${host.parentSessionId}-task-${host.newId()}`.replace(/[^A-Za-z0-9_-]/g, '');
        child = host.spawn({ taskId, type, tools: childTools(type) });
        children.set(taskId, { session: child, type });
      }
      const running = child;
      const id = taskId;

      const base = { turnId: context.turnId, toolCallId: context.toolCallId, taskId: id };
      const emit = (payload: EventPayload) => context.emit?.(payload);

      const release = await slots.acquire(context.signal);
      const started = Date.now();
      const onAbort = () => running.interrupt('parent cancelled');
      context.signal.addEventListener('abort', onAbort, { once: true });
      emit({
        type: 'subagent.started',
        ...base,
        description: input.description,
        agentType: type.name,
        resumed,
      });

      let turns = 0;
      let toolCalls = 0;
      let usage: ModelUsage | undefined;
      let finalText = '';
      let status: 'completed' | 'failed' | 'cancelled' | 'max_turns' = 'completed';
      let failure: string | undefined;
      try {
        for await (const event of running.run({ prompt: input.prompt })) {
          switch (event.type) {
            case 'turn.started':
              turns = Math.max(turns, event.turn);
              emit({
                type: 'subagent.progress',
                ...base,
                kind: 'turn',
                message: `Turn ${event.turn}`,
                data: { turn: event.turn },
              });
              break;
            case 'tool.started':
              toolCalls += 1;
              emit({
                type: 'subagent.progress',
                ...base,
                kind: 'tool.started',
                message: describeCall(event.call.name, event.call.input),
                data: { toolName: event.call.name, toolCallId: event.call.id },
              });
              break;
            case 'tool.completed':
              emit({
                type: 'subagent.progress',
                ...base,
                kind: 'tool.completed',
                message: event.result.isError ? 'Tool failed' : 'Tool completed',
                data: { toolCallId: event.result.toolCallId, isError: event.result.isError },
              });
              break;
            case 'context.usage':
              if (event.compacted || event.action === 'compaction') {
                emit({
                  type: 'subagent.progress',
                  ...base,
                  kind: 'context',
                  message: `Context compacted to ${event.usedPercent}%`,
                  data: { usedPercent: event.usedPercent, action: event.action ?? 'compaction' },
                });
              }
              break;
            case 'usage.updated':
              usage = addUsage(usage, event.usage);
              break;
            case 'assistant.message.completed': {
              const text = event.message.content
                .filter((block) => block.type === 'text')
                .map((block) => (block as { text: string }).text)
                .join('');
              if (text.trim()) finalText = text;
              break;
            }
            case 'warning':
            case 'agent.intervention':
              emit({
                type: 'subagent.progress',
                ...base,
                kind: 'warning',
                message: event.message,
                data: { code: event.type === 'warning' ? event.code : event.kind },
              });
              break;
            // A child asking permission is surfaced as the parent's own request: the
            // caller answers it on the parent, which routes it back here.
            case 'permission.requested':
            case 'permission.resolved': {
              const {
                protocolVersion: _v,
                sequence: _s,
                timestamp: _t,
                sessionId: _i,
                ...rest
              } = event;
              emit(rest as EventPayload);
              break;
            }
            case 'error':
              failure = event.message;
              break;
            case 'session.completed':
              if (event.reason === 'cancelled') status = 'cancelled';
              else if (event.reason === 'max_turns') status = 'max_turns';
              else if (event.reason === 'model_error' || event.reason === 'budget_exceeded')
                status = 'failed';
              break;
          }
        }
      } catch (error) {
        status = context.signal.aborted ? 'cancelled' : 'failed';
        failure = errorMessage(error);
      } finally {
        context.signal.removeEventListener('abort', onAbort);
        release();
      }

      emit({
        type: 'subagent.completed',
        ...base,
        status,
        turns,
        toolCalls,
        durationMs: Date.now() - started,
        ...(usage === undefined ? {} : { usage }),
        summary: finalText.slice(0, SUMMARY_PREVIEW_CHARS),
        ...(failure === undefined ? {} : { error: failure }),
      });

      const lines = [
        `task_id: ${id} (pass this as task_id to resume the same agent if needed)`,
        `status: ${status}`,
        '',
        '<task_result>',
        finalText ||
          (failure ? `The subagent failed: ${failure}` : '(the subagent returned no text)'),
        '</task_result>',
      ];
      return {
        content: lines.join('\n'),
        isError: status === 'failed' || status === 'cancelled',
        metadata: { taskId: id, agentType: type.name, status, turns, toolCalls, resumed },
      };
    },
  };
  return tool;
}

/**
 * The delegation guidance, in the tool description where the model reads it at
 * the moment it decides. Condensed from CodeGenie's `task.txt` and the wave rules
 * of its orchestrator prompt.
 */
function taskDescription(types: readonly SubagentType[]): string {
  return `Launch a subagent to handle a complex, multi-step piece of work autonomously in its own fresh context.

Available agent types:
${types.map((type) => `- ${type.name}: ${type.description}`).join('\n')}

When to use it:
- The work is large enough that doing it inline would flood your context (broad searches, reading many files, long investigations).
- The task splits into independent pieces that can run in parallel.

When not to use it:
- Reading one known file, or searching for a specific symbol in 2-3 files: use the file tools directly, it is faster.

How to delegate large tasks:
1. Understand the task first (an explore agent is good for this), then break it into subtasks and note which files each will touch.
2. Classify dependencies. Independent subtasks go in the same wave: launch them together as multiple task calls in ONE message and they run concurrently. Subtasks that need an earlier result go in a later wave.
3. Agents share the same working directory. Subtasks likely to edit the same files MUST be in different waves. When unsure about overlap, run them sequentially.
4. After each wave, read the results, reassess the plan (a result may change what is needed next), then launch the next wave.
5. When all waves are done, verify and synthesise the results for the user.

Usage notes:
- Each agent starts with no knowledge of this conversation. The prompt must be self-contained: goal, relevant paths and prior findings, constraints, whether it should change files or only research, how to verify, and exactly what to report back.
- The agent's final message is returned to you, not shown to the user. Summarise what matters in your own reply.
- The result includes a task_id; pass it back as task_id to continue the same agent with its previous history.
- Subagents cannot launch further subagents.`;
}

function describeCall(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const hint = record.path ?? record.pattern ?? record.command ?? record.url ?? record.query;
    if (typeof hint === 'string' && hint) return `${name} ${hint.slice(0, 120)}`;
  }
  return name;
}

function addUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  if (!current) return { ...next };
  const sum = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const result: ModelUsage = {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
  };
  const cacheRead = sum(current.cacheReadTokens, next.cacheReadTokens);
  const cacheWrite = sum(current.cacheWriteTokens, next.cacheWriteTokens);
  const reasoning = sum(current.reasoningTokens, next.reasoningTokens);
  const cost = sum(current.estimatedCostUsd, next.estimatedCostUsd);
  if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  if (cost !== undefined) result.estimatedCostUsd = cost;
  return result;
}

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AgentHarnessError('Cancelled while waiting for a subagent slot', 'ABORTED'));
      };
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wake);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

export type { ToolExecutionContext };
