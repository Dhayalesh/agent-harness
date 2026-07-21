export class AgentHarnessError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly recoverable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentHarnessError';
  }
}

export class AgentAbortError extends AgentHarnessError {
  constructor(message = 'Agent session was interrupted') {
    super(message, 'SESSION_ABORTED', false);
    this.name = 'AgentAbortError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
