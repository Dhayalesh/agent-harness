import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { Tool } from '../tool.js';

/**
 * Ported from `claude-code/src/tools/EnterPlanModeTool/` and
 * `ExitPlanModeTool/ExitPlanModeV2Tool.ts`.
 *
 * Upstream keeps the mode on `AppState.toolPermissionContext` and restores
 * `prePlanMode` on exit. The harness has no app state, so the mode lives in a
 * `PlanModeController` that both the tools and the permission layer read. The
 * enforcement half matters more than the tools: without a permission gate,
 * "plan mode" is only a suggestion to the model.
 */

export type PlanModeState = {
  active: boolean;
  /** Plan text captured by `exit_plan_mode`, if any. */
  plan?: string;
  enteredAt?: string;
  exitedAt?: string;
};

export type PlanModeListener = (state: PlanModeState) => void;

export class PlanModeController {
  private state: PlanModeState = { active: false };
  private readonly listeners = new Set<PlanModeListener>();
  private hasExited = false;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  get active(): boolean {
    return this.state.active;
  }

  /** True once plan mode has been exited in this session. */
  get exitedOnce(): boolean {
    return this.hasExited;
  }

  snapshot(): PlanModeState {
    return { ...this.state };
  }

  enter(): void {
    if (this.state.active) {
      throw new AgentHarnessError('Already in plan mode', 'PLAN_MODE_ACTIVE');
    }
    this.state = { active: true, enteredAt: this.clock().toISOString() };
    this.emit();
  }

  exit(plan?: string): void {
    if (!this.state.active) {
      throw new AgentHarnessError('Not in plan mode', 'PLAN_MODE_INACTIVE');
    }
    this.hasExited = true;
    this.state = {
      active: false,
      exitedAt: this.clock().toISOString(),
      ...(plan === undefined ? {} : { plan }),
    };
    this.emit();
  }

  onChange(listener: PlanModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        // A listener failure must not break the transition.
      }
    }
  }
}

const enterSchema = z.object({});
const exitSchema = z.object({
  plan: z.string().min(1).describe('The implementation plan to present for approval, in Markdown.'),
});

const ENTER_DESCRIPTION =
  'Request permission to enter plan mode for a complex task that needs exploration and design before any changes are made.';

const EXIT_DESCRIPTION =
  'Present your finished plan to the user for approval and leave plan mode. Only call this once the plan is complete.';

const ENTER_RESULT = `Entered plan mode. Focus on exploring the codebase and designing an implementation approach.

In plan mode you should:
1. Explore thoroughly to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use ask_user_question if you need to clarify the approach
5. Design a concrete implementation strategy
6. Call exit_plan_mode when ready to present the plan

DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`;

export function createPlanModeTools(controller: PlanModeController): Tool[] {
  const enterTool: Tool<z.infer<typeof enterSchema>> = {
    name: 'enter_plan_mode',
    description: ENTER_DESCRIPTION,
    inputSchema: enterSchema,
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'read',
    concurrencySafe: true,
    checkPermissions() {
      return { decision: 'allow', reason: 'Plan mode only removes capability' };
    },
    async execute() {
      controller.enter();
      return { content: ENTER_RESULT, metadata: { planMode: controller.snapshot() } };
    },
  };

  const exitTool: Tool<z.infer<typeof exitSchema>> = {
    name: 'exit_plan_mode',
    description: EXIT_DESCRIPTION,
    inputSchema: exitSchema,
    jsonSchema: {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
      additionalProperties: false,
    },
    // Read-only in effect, but it must never be auto-approved: the approval *is*
    // the feature. Upstream returns `behavior: 'ask'` from checkPermissions for
    // exactly this reason.
    kind: 'interactive',
    concurrencySafe: true,
    checkPermissions() {
      if (!controller.active) {
        return {
          decision: 'deny',
          reason: 'Not in plan mode. This tool only exits plan mode after a plan has been written.',
        };
      }
      return { decision: 'ask', reason: 'Exit plan mode and start making changes?' };
    },
    async execute(input) {
      controller.exit(input.plan);
      return {
        content: [
          'User approved the plan. You can now start implementing.',
          'Start by recording the steps with todo_write if the plan has more than a couple of steps.',
          '',
          '## Approved plan',
          input.plan,
        ].join('\n'),
        metadata: { planMode: controller.snapshot() },
      };
    },
  };

  return [enterTool, exitTool];
}
