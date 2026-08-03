import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { Tool } from '../tool.js';

/**
 * Ported from `claude-code/src/tools/TodoWriteTool/`.
 *
 * Upstream stores the list on `AppState` keyed by session or agent id. The
 * harness has no global app state by design, so the list lives in an injectable
 * `TodoStore` that adapters can read for rendering and persist alongside the
 * session transcript.
 *
 * The two upstream behaviours worth preserving exactly:
 *  - exactly one task may be `in_progress` at a time
 *  - when every task is `completed`, the stored list is cleared, but the tool
 *    result still reports what was completed
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  content: string;
  status: TodoStatus;
  /** Present-tense form shown while the item is in progress. */
  activeForm: string;
};

const todoSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1),
});

const schema = z.object({
  todos: z.array(todoSchema),
});

export class TodoStore {
  private readonly lists = new Map<string, TodoItem[]>();

  get(key: string): readonly TodoItem[] {
    return this.lists.get(key) ?? [];
  }

  set(key: string, todos: readonly TodoItem[]): void {
    if (todos.length === 0) this.lists.delete(key);
    else this.lists.set(key, [...todos]);
  }

  keys(): readonly string[] {
    return [...this.lists.keys()];
  }

  clear(): void {
    this.lists.clear();
  }
}

export const DESCRIPTION = `Use this tool to create and manage a structured task list for the current work session. It helps track progress, organise multi-step work, and shows the user what you are doing.

Use it when a task needs three or more distinct steps, when the user gives multiple requirements, or when you need to resume long-running work after an interruption. Skip it for single-step tasks.

Rules:
- Exactly one task may be in_progress at a time.
- Mark a task completed immediately after finishing it; do not batch completions.
- Never mark a task completed if tests fail, the implementation is partial, or you hit unresolved errors. Keep it in_progress and add a new task for what is blocking.
- Each task needs both an imperative \`content\` ("Run the build") and a present-tense \`activeForm\` ("Running the build").`;

export function createTodoWriteTool(
  store: TodoStore = new TodoStore(),
): Tool<z.infer<typeof schema>> {
  return {
    name: 'todo_write',
    description: DESCRIPTION,
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The updated todo list, sent in full on every call',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative form, e.g. "Run the build"' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: {
                type: 'string',
                description: 'Present continuous form, e.g. "Running the build"',
              },
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: false,
    checkPermissions() {
      // Upstream: "No permission checks required for todo operations."
      return { decision: 'allow', reason: 'Session bookkeeping only' };
    },
    async execute(input, context) {
      const inProgress = input.todos.filter((todo) => todo.status === 'in_progress');
      if (inProgress.length > 1) {
        throw new AgentHarnessError(
          `Only one task may be in_progress at a time; received ${inProgress.length}`,
          'TODO_MULTIPLE_IN_PROGRESS',
        );
      }
      const duplicates = findDuplicates(input.todos.map((todo) => todo.content));
      if (duplicates.length > 0) {
        throw new AgentHarnessError(
          `Duplicate task content: ${duplicates.join(', ')}`,
          'TODO_DUPLICATE_CONTENT',
        );
      }

      const key = context.sessionId;
      const previous = store.get(key);
      const allCompleted =
        input.todos.length > 0 && input.todos.every((todo) => todo.status === 'completed');
      store.set(key, allCompleted ? [] : input.todos);

      const counts = {
        pending: input.todos.filter((todo) => todo.status === 'pending').length,
        inProgress: inProgress.length,
        completed: input.todos.filter((todo) => todo.status === 'completed').length,
      };

      return {
        content: [
          'Todos have been modified successfully. Keep using the todo list to track progress.',
          '',
          formatTodos(input.todos),
        ].join('\n'),
        metadata: {
          previousTodos: previous,
          todos: input.todos,
          counts,
          cleared: allCompleted,
        },
      };
    },
  };
}

export function formatTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return '(no tasks)';
  return todos
    .map((todo) => {
      const marker =
        todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
      const label = todo.status === 'in_progress' ? todo.activeForm : todo.content;
      return `${marker} ${label}`;
    })
    .join('\n');
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}
