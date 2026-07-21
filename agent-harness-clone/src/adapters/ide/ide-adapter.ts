import type { AgentEvent } from '../../core/events.js';
import type { GatewaySession, SessionGateway } from '../../gateway/session-gateway.js';

export type IdeContext = {
  workspace?: string;
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  diagnostics?: Array<{
    file: string;
    line: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
  }>;
};

export class IdeAgentAdapter {
  constructor(
    private readonly gateway: SessionGateway,
    private readonly ideInstanceId: string,
  ) {}

  createSession(): Promise<GatewaySession> {
    return this.gateway.create(`ide:${this.ideInstanceId}`);
  }

  run(
    session: GatewaySession,
    prompt: string,
    context: IdeContext = {},
    idempotencyKey?: string,
  ): Promise<AgentEvent[]> {
    return this.gateway.run(
      session.sessionId,
      session.controlToken,
      buildIdePrompt(prompt, context),
      idempotencyKey,
    );
  }
}

export function buildIdePrompt(prompt: string, context: IdeContext): string {
  const blocks = [prompt];
  if (context.workspace) blocks.push(`<workspace>${context.workspace}</workspace>`);
  if (context.activeFile) blocks.push(`<active-file>${context.activeFile}</active-file>`);
  if (context.selection) {
    blocks.push(
      `<selection lines="${context.selection.startLine}-${context.selection.endLine}">\n${context.selection.text}\n</selection>`,
    );
  }
  if (context.diagnostics?.length) {
    blocks.push(`<diagnostics>\n${JSON.stringify(context.diagnostics)}\n</diagnostics>`);
  }
  return blocks.join('\n\n');
}
