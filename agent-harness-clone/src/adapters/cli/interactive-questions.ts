import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { AgentHarnessError } from '../../core/errors.js';
import {
  OTHER_OPTION_LABEL,
  type UserQuestionAnswer,
  type UserQuestionHandler,
  type UserQuestionRequest,
} from '../../tools/interactive/ask-user-question.js';

/**
 * Terminal implementation of `UserQuestionHandler`.
 *
 * Stands in for claude-code's Ink dialog (`AskUserQuestionTool/UI.tsx`). The
 * numbered-list rendering is deliberately plain so the same handler works over a
 * pipe, in CI logs, and in a real TTY.
 */
export class InteractiveCliQuestionHandler implements UserQuestionHandler {
  async ask(request: UserQuestionRequest): Promise<readonly UserQuestionAnswer[]> {
    if (!stdin.isTTY) {
      throw new AgentHarnessError(
        'Cannot ask the user a question without an interactive terminal',
        'NO_TTY',
      );
    }
    const answers: UserQuestionAnswer[] = [];
    const prompt = createInterface({ input: stdin, output: stdout });
    const onAbort = (): void => prompt.close();
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (const question of request.questions) {
        request.signal.throwIfAborted();
        const labels = [...question.options.map((option) => option.label), OTHER_OPTION_LABEL];

        stdout.write(`\n[${question.header}] ${question.question}\n`);
        question.options.forEach((option, index) => {
          stdout.write(`  ${index + 1}) ${option.label} — ${option.description}\n`);
        });
        stdout.write(`  ${labels.length}) ${OTHER_OPTION_LABEL} (type your own answer)\n`);

        const hint = question.multiSelect === true ? 'numbers, comma-separated' : 'number';
        const raw = (await prompt.question(`Choose (${hint}): `)).trim();
        const picked = parseSelection(raw, labels.length, question.multiSelect === true);

        if (picked.includes(labels.length)) {
          const other = (await prompt.question('Your answer: ')).trim();
          answers.push({
            question: question.question,
            selected: [OTHER_OPTION_LABEL],
            ...(other === '' ? {} : { other }),
          });
          continue;
        }
        answers.push({
          question: question.question,
          selected: picked.map((index) => labels[index - 1] ?? ''),
        });
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      prompt.close();
    }
    return answers;
  }
}

function parseSelection(raw: string, max: number, multiSelect: boolean): number[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const indexes: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 1 || value > max) continue;
    if (!indexes.includes(value)) indexes.push(value);
  }
  if (indexes.length === 0) {
    throw new AgentHarnessError(`No valid choice in "${raw}"`, 'INVALID_SELECTION');
  }
  return multiSelect ? indexes : indexes.slice(0, 1);
}
