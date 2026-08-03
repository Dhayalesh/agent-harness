import type { PlanModeController } from '../tools/planning/plan-mode.js';
import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './permission-handler.js';

/**
 * Enforces plan mode by wrapping another handler.
 *
 * Port of the `mode === 'plan'` branch of claude-code's permission pipeline. It
 * is a decorator rather than a mode flag so any handler composition keeps
 * working: `new PlanModePermissionHandler(controller, new RulePermissionHandler(...))`.
 *
 * While plan mode is active, every tool that can change state is denied,
 * including tools an allowlist rule would otherwise approve. That ordering is
 * deliberate: plan mode is a promise to the user that nothing will be modified,
 * and a stale allow-rule should not be able to break it.
 */
export class PlanModePermissionHandler implements PermissionHandler {
  /** Tools that stay available in plan mode despite not being `kind: 'read'`. */
  private readonly exempt: ReadonlySet<string>;

  constructor(
    private readonly controller: PlanModeController,
    private readonly inner: PermissionHandler,
    exemptTools: readonly string[] = [
      'todo_write',
      'enter_plan_mode',
      'exit_plan_mode',
      'ask_user_question',
    ],
  ) {
    this.exempt = new Set(exemptTools);
  }

  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    if (!this.controller.active) return this.inner.evaluate(request);
    if (this.exempt.has(request.tool.name)) return this.inner.evaluate(request);
    if (request.tool.kind === 'read') return this.inner.evaluate(request);
    // A tool that inspected its own input and found it harmless is still
    // read-only in effect (e.g. `bash git status`).
    if (request.toolCheck?.decision === 'allow') return this.inner.evaluate(request);
    return 'deny';
  }
}
