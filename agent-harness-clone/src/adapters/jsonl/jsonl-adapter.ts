import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentSession } from '../../core/agent-session.js';
import { parseCommand, serializeEvent } from '../../transports/jsonl.js';

export async function runJsonlAdapter(
  session: AgentSession,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let active: Promise<void> | undefined;
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const command = parseCommand(line);
      switch (command.type) {
        case 'run':
          if (active) throw new Error('A run is already active');
          active = (async () => {
            try {
              for await (const event of session.run({ prompt: command.prompt })) {
                output.write(serializeEvent(event));
              }
            } finally {
              active = undefined;
            }
          })();
          break;
        case 'permission':
          session.respondToPermission(command.requestId, command.decision);
          break;
        case 'interrupt':
          session.interrupt(command.reason);
          break;
        case 'close':
          await session.close();
          break;
      }
    } catch (error) {
      output.write(
        `${JSON.stringify({
          protocolVersion: 1,
          type: 'transport.error',
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
  await active;
}
