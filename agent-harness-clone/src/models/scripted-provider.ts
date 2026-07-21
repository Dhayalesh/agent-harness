import { AgentAbortError, AgentHarnessError } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from './provider.js';

export type ScriptedStep =
  | readonly ModelStreamEvent[]
  | ((request: ModelRequest) => readonly ModelStreamEvent[] | Promise<readonly ModelStreamEvent[]>);

export class ScriptedModelProvider implements ModelProvider {
  readonly name = 'scripted';
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptedStep[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.signal.aborted) throw new AgentAbortError();

    const step = this.steps[this.cursor++];
    if (!step) {
      throw new AgentHarnessError(
        `Scripted provider has no response for request ${this.cursor}`,
        'SCRIPT_EXHAUSTED',
      );
    }

    const events = typeof step === 'function' ? await step(request) : step;
    for (const event of events) {
      if (request.signal.aborted) throw new AgentAbortError();
      yield structuredClone(event);
    }
  }
}
