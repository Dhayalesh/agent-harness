import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from '../../permissions/permission-handler.js';

export class InteractiveCliPermissionHandler implements PermissionHandler {
  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    // A tool that inspected its own input is more precise than `kind`: `bash`
    // running `git status` reports `allow`, `bash` running `rm -rf` does not.
    if (request.toolCheck?.decision === 'allow') return 'allow';
    if (request.toolCheck === undefined && request.tool.kind === 'read') return 'allow';
    if (!stdin.isTTY) return 'deny';

    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      if (request.toolCheck?.reason !== undefined) {
        stdout.write(`\n${request.toolCheck.reason}\n`);
      }
      if (request.toolCheck?.warning !== undefined) {
        stdout.write(`${request.toolCheck.warning}\n`);
      }
      const answer = await prompt.question(
        `Allow ${request.tool.name} with ${JSON.stringify(request.input)}? [y/N] `,
      );
      return /^y(?:es)?$/i.test(answer.trim()) ? 'allow' : 'deny';
    } finally {
      prompt.close();
    }
  }
}
