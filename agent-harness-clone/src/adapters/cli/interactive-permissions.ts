import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from '../../permissions/permission-handler.js';

export class InteractiveCliPermissionHandler implements PermissionHandler {
  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.tool.kind === 'read') return 'allow';
    if (!stdin.isTTY) return 'deny';
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(
        `Allow ${request.tool.name} with ${JSON.stringify(request.input)}? [y/N] `,
      );
      return /^y(?:es)?$/i.test(answer.trim()) ? 'allow' : 'deny';
    } finally {
      prompt.close();
    }
  }
}
