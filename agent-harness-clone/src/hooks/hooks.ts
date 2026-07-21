import type { AgentMessage, ToolCallBlock, ToolResultBlock } from '../core/messages.js';
import type { ModelRequest, StopReason } from '../models/provider.js';

export type HookContext = {
  sessionId: string;
  turnId: string;
};

export type BeforeToolResult = {
  allow: boolean;
  message?: string;
};

export type StopHookResult = {
  continueWithPrompt?: string;
};

export interface AgentHook {
  readonly name: string;
  beforeModel?(context: HookContext, request: ModelRequest): Promise<void> | void;
  afterModel?(
    context: HookContext,
    message: AgentMessage,
    stopReason: StopReason,
  ): Promise<void> | void;
  beforeTool?(
    context: HookContext,
    call: ToolCallBlock,
  ): BeforeToolResult | Promise<BeforeToolResult>;
  afterTool?(
    context: HookContext,
    call: ToolCallBlock,
    result: ToolResultBlock,
  ): Promise<void> | void;
  onStop?(
    context: HookContext,
    messages: readonly AgentMessage[],
  ): StopHookResult | Promise<StopHookResult>;
}

export class HookRegistry {
  private readonly hooks: AgentHook[] = [];

  constructor(initialHooks: readonly AgentHook[] = []) {
    for (const hook of initialHooks) this.register(hook);
  }

  register(hook: AgentHook): () => void {
    if (this.hooks.some((existing) => existing.name === hook.name)) {
      throw new Error(`Hook already registered: ${hook.name}`);
    }
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    };
  }

  list(): readonly AgentHook[] {
    return [...this.hooks];
  }
}
