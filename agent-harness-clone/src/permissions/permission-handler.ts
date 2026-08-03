import type { Tool, ToolPermissionCheck } from '../tools/tool.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type PermissionRequest = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  tool: Tool;
  input: unknown;
  workingDirectory: string;
  /**
   * Verdict from the tool's own `checkPermissions`, when it has one. The session
   * short-circuits a `deny` before any handler runs, so handlers only ever see
   * `allow` or `ask` here — but they should still consult it, because a tool
   * asking is a stronger signal than the tool's static `kind`.
   */
  toolCheck?: ToolPermissionCheck;
};

export interface PermissionHandler {
  evaluate(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>;
}

export class DefaultPermissionHandler implements PermissionHandler {
  evaluate({ tool, toolCheck }: PermissionRequest): PermissionDecision {
    if (toolCheck) return toolCheck.decision;
    return tool.kind === 'read' ? 'allow' : 'ask';
  }
}

export class AllowAllPermissionHandler implements PermissionHandler {
  evaluate(): PermissionDecision {
    return 'allow';
  }
}

export class DenyAllPermissionHandler implements PermissionHandler {
  evaluate(): PermissionDecision {
    return 'deny';
  }
}
