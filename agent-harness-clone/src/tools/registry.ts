import { AgentHarnessError } from '../core/errors.js';
import type { Tool, ToolDescriptor } from './tool.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(initialTools: readonly Tool[] = []) {
    for (const tool of initialTools) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new AgentHarnessError(`Tool already registered: ${tool.name}`, 'DUPLICATE_TOOL');
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }
}
