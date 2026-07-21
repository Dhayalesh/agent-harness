export type PromptCommand = {
  type: 'prompt';
  name: string;
  description: string;
  expand(args: string): string | Promise<string>;
};

export type LocalCommand = {
  type: 'local';
  name: string;
  description: string;
  run(args: string): string | Promise<string>;
};

export type AgentCommand = PromptCommand | LocalCommand;

export type CommandResolution =
  | { type: 'prompt'; prompt: string }
  | { type: 'local'; output: string }
  | { type: 'none'; prompt: string };

export class CommandRegistry {
  private readonly commands = new Map<string, AgentCommand>();

  register(command: AgentCommand): () => void {
    if (this.commands.has(command.name))
      throw new Error(`Command already registered: ${command.name}`);
    this.commands.set(command.name, command);
    return () => this.commands.delete(command.name);
  }

  list(): AgentCommand[] {
    return [...this.commands.values()];
  }

  async resolve(input: string): Promise<CommandResolution> {
    if (!input.startsWith('/')) return { type: 'none', prompt: input };
    const [name = '', ...parts] = input.slice(1).split(/\s+/);
    const command = this.commands.get(name);
    if (!command) return { type: 'none', prompt: input };
    const args = parts.join(' ');
    if (command.type === 'prompt') return { type: 'prompt', prompt: await command.expand(args) };
    return { type: 'local', output: await command.run(args) };
  }
}
