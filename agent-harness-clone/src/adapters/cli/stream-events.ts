import type { AgentSession } from '../../core/agent-session.js';

/**
 * Renders one run to the terminal: the reply on stdout, everything else on
 * stderr, so `npm run ... > answer.txt` keeps the answer and drops the trace.
 *
 * Shared by the CLI entrypoints so a run looks the same whichever one started
 * it. Returns true when the session reported an error, which the caller turns
 * into an exit code.
 */
export async function streamSessionToStdout(
  session: AgentSession,
  prompt: string,
): Promise<boolean> {
  let failed = false;
  for await (const event of session.run({ prompt })) {
    if (event.type === 'assistant.text.delta') process.stdout.write(event.delta);
    if (event.type === 'tool.started') {
      process.stderr.write(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.input)}\n`);
    }
    if (event.type === 'tool.completed') {
      process.stderr.write(
        `[tool ${event.result.isError ? 'error' : 'done'}] ${event.result.content}\n`,
      );
    }
    if (event.type === 'warning') {
      process.stderr.write(`\n[warning ${event.code}] ${event.message}\n`);
    }
    if (event.type === 'error') {
      failed = true;
      process.stderr.write(`\n[error ${event.code}] ${event.message}\n`);
    }
    if (event.type === 'session.completed') {
      process.stdout.write('\n');
      if (event.reason !== 'end_turn') {
        process.stderr.write(`[session ${event.reason}]\n`);
      }
    }
  }
  return failed;
}
