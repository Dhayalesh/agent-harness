import type { Tool } from '../tools/tool.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type PermissionRequest = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  tool: Tool;
  input: unknown;
  workingDirectory: string;
};

export interface PermissionHandler {
  evaluate(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>;
}

export class DefaultPermissionHandler implements PermissionHandler {
  evaluate({ tool }: PermissionRequest): PermissionDecision {
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
