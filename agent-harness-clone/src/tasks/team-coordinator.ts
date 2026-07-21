import { z } from 'zod';
import type { AgentSession } from '../core/agent-session.js';
import type { Tool } from '../tools/tool.js';

export type TeamAgentDefinition = {
  role: string;
  description: string;
  allowedTools?: string[];
  maxTurns?: number;
};

export type TeamAgentResult = {
  role: string;
  output: string;
  status: 'completed' | 'failed';
  error?: string;
};

export type TeamRunResult = {
  results: TeamAgentResult[];
  synthesis?: string;
};

export type TeamCoordinatorOptions = {
  agents: readonly TeamAgentDefinition[];
  createAgent(definition: TeamAgentDefinition): AgentSession | Promise<AgentSession>;
  createCoordinator?: () => AgentSession | Promise<AgentSession>;
  maxConcurrent?: number;
};

export class AgentTeamCoordinator {
  constructor(private readonly options: TeamCoordinatorOptions) {}

  async run(prompt: string, signal?: AbortSignal): Promise<TeamRunResult> {
    const limit = this.options.maxConcurrent ?? 4;
    const results: TeamAgentResult[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, this.options.agents.length) },
      async () => {
        while (cursor < this.options.agents.length) {
          const definition = this.options.agents[cursor++];
          if (!definition) return;
          results.push(await this.runAgent(definition, prompt, signal));
        }
      },
    );
    await Promise.all(workers);
    results.sort(
      (left, right) =>
        this.options.agents.findIndex((agent) => agent.role === left.role) -
        this.options.agents.findIndex((agent) => agent.role === right.role),
    );
    if (!this.options.createCoordinator) return { results };

    const coordinator = await this.options.createCoordinator();
    const synthesisPrompt = [
      `Synthesize the team results for this request: ${prompt}`,
      ...results.map((result) => `## ${result.role}\n${result.output}`),
    ].join('\n\n');
    let synthesis = '';
    try {
      const abort = (): void => coordinator.interrupt('team run cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      for await (const event of coordinator.run({ prompt: synthesisPrompt })) {
        if (event.type === 'assistant.text.delta') synthesis += event.delta;
      }
    } finally {
      await coordinator.close();
    }
    return { results, synthesis };
  }

  private async runAgent(
    definition: TeamAgentDefinition,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<TeamAgentResult> {
    const session = await this.options.createAgent(definition);
    let output = '';
    try {
      const abort = (): void => session.interrupt('team run cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      for await (const event of session.run({
        prompt: `Your role is ${definition.role}: ${definition.description}\n\n${prompt}`,
      })) {
        if (event.type === 'assistant.text.delta') output += event.delta;
      }
      await session.close();
      return { role: definition.role, output, status: 'completed' };
    } catch (error) {
      await session.close().catch(() => undefined);
      return {
        role: definition.role,
        output,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const teamInput = z.object({ prompt: z.string().min(1) });

export function createTeamTool(coordinator: AgentTeamCoordinator): Tool<z.infer<typeof teamInput>> {
  return {
    name: 'team_run',
    description: 'Delegate a request to a configured team of scoped agents',
    inputSchema: teamInput,
    jsonSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    kind: 'execute',
    concurrencySafe: false,
    async execute({ prompt }, context) {
      const result = await coordinator.run(prompt, context.signal);
      return { content: JSON.stringify(result), metadata: { teamSize: result.results.length } };
    },
  };
}
