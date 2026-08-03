import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './permission-handler.js';

export type PermissionMode = 'default' | 'plan' | 'bypass' | 'deny';

export type PermissionRule = {
  tool: string;
  decision: Exclude<PermissionDecision, 'ask'>;
  inputPattern?: string;
  source?: string;
};

export type RulePermissionOptions = {
  mode?: PermissionMode;
  rules?: readonly PermissionRule[];
  fallback?: PermissionDecision;
};

export class RulePermissionHandler implements PermissionHandler {
  private readonly mode: PermissionMode;
  private readonly rules: readonly PermissionRule[];
  private readonly fallback: PermissionDecision;

  constructor(options: RulePermissionOptions = {}) {
    this.mode = options.mode ?? 'default';
    this.rules = options.rules ?? [];
    this.fallback = options.fallback ?? 'ask';
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    if (this.mode === 'bypass') return 'allow';
    if (this.mode === 'deny') return 'deny';

    for (const rule of this.rules) {
      if (!wildcardMatch(rule.tool, request.tool.name)) continue;
      if (
        rule.inputPattern !== undefined &&
        !wildcardMatch(rule.inputPattern, stableInput(request.input))
      ) {
        continue;
      }
      return rule.decision;
    }

    if (this.mode === 'plan' && !isReadOnly(request)) return 'deny';
    // A tool that inspected its own input outranks the static `kind`: `bash` is
    // always `kind: 'execute'`, but `git status` and `rm -rf` are not the same
    // request. Rules above can still auto-approve either, which is the point of
    // an allowlist.
    if (request.toolCheck) return request.toolCheck.decision;
    if (request.tool.kind === 'read') return 'allow';
    return this.fallback;
  }
}

/**
 * Plan mode blocks anything that can change state. A tool whose own check says
 * `allow` is treated as read-only even when its `kind` is not, so `todo_write`
 * and `enter_plan_mode` keep working while `bash rm -rf` does not.
 */
function isReadOnly(request: PermissionRequest): boolean {
  if (request.tool.kind === 'read') return true;
  return request.toolCheck?.decision === 'allow';
}

function stableInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const preferred = record.command ?? record.path ?? record.filePath;
    if (typeof preferred === 'string') return preferred;
  }
  return JSON.stringify(input);
}

function wildcardMatch(pattern: string, value: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(value);
}
