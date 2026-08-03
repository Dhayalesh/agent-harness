import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { Tool } from '../tool.js';

/**
 * Ported from `claude-code/src/tools/AskUserQuestionTool/`.
 *
 * Upstream renders an Ink multiple-choice dialog and reads the answer from the
 * permission component. The harness is UI-independent, so the rendering half
 * becomes a `UserQuestionHandler` port that each adapter implements (CLI, IDE,
 * server, desktop). The schema, the 1-4 question / 2-4 option limits, the
 * uniqueness rule, and the automatic "Other" affordance are preserved.
 */

const questionOptionSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      'Display text for this option. Concise (1-5 words) and clearly describes the choice.',
    ),
  description: z
    .string()
    .describe('What this option means or what happens if chosen. Use it to explain trade-offs.'),
});

const questionSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('The complete question. Clear, specific, and ending with a question mark.'),
  header: z.string().min(1).max(12).describe('Very short chip label, max 12 characters.'),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 distinct choices. Do not add an 'Other' option; one is offered automatically."),
  multiSelect: z
    .boolean()
    .optional()
    .describe('Allow selecting more than one option. Use when choices are not mutually exclusive.'),
});

const schema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});

export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type Question = z.infer<typeof questionSchema>;

export type UserQuestionRequest = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  questions: readonly Question[];
  signal: AbortSignal;
};

export type UserQuestionAnswer = {
  /** Must match the `question` text it answers. */
  question: string;
  /** Selected labels. Multi-select answers carry more than one. */
  selected: readonly string[];
  /** Free-text answer when the user chose the automatic "Other" affordance. */
  other?: string;
  /** Optional notes the user attached to the selection. */
  notes?: string;
};

/**
 * Port implemented per adapter. Implementations must reject when `signal` aborts
 * so an interrupted turn does not leave the tool hanging.
 */
export interface UserQuestionHandler {
  ask(request: UserQuestionRequest): Promise<readonly UserQuestionAnswer[]>;
}

/** Label offered automatically alongside the model's options. */
export const OTHER_OPTION_LABEL = 'Other';

export const DESCRIPTION = `Ask the user a multiple-choice question when you need a decision only they can make.

Use it when the task is genuinely ambiguous and guessing wrong would waste work or cause harm: which system or environment to target, which of several valid approaches to take, or which of two conflicting requirements wins.

Do not use it for things you can determine yourself by reading code, running a command, or searching. Do not use it to ask permission to proceed with work you have already been asked to do.

Each question needs 2-4 mutually exclusive options (unless multiSelect is true). An "Other" choice is added automatically, so never write one yourself.`;

export function createAskUserQuestionTool(
  handler: UserQuestionHandler,
): Tool<z.infer<typeof schema>> {
  return {
    name: 'ask_user_question',
    description: DESCRIPTION,
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', maxLength: 12 },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question', 'header', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    kind: 'interactive',
    concurrencySafe: false,
    checkPermissions() {
      // The tool *is* the prompt; a second approval step would ask the user to
      // consent to being asked. Upstream reaches the same conclusion by routing
      // this tool through the question dialog instead of the permission dialog.
      return { decision: 'allow', reason: 'Tool interacts with the user directly' };
    },
    async execute(input, context) {
      assertUnique(input.questions);

      const answers = await handler.ask({
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        questions: input.questions,
        signal: context.signal,
      });

      const byQuestion = new Map(answers.map((answer) => [answer.question, answer]));
      const missing = input.questions
        .map((question) => question.question)
        .filter((question) => !byQuestion.has(question));
      if (missing.length > 0) {
        throw new AgentHarnessError(
          `No answer returned for: ${missing.join('; ')}`,
          'QUESTION_UNANSWERED',
        );
      }

      const lines = input.questions.map((question) => {
        const answer = byQuestion.get(question.question);
        const selected = answer?.other ?? (answer?.selected ?? []).join(', ');
        const notes = answer?.notes === undefined ? '' : ` (notes: ${answer.notes})`;
        return `${question.question} -> ${selected || '(no selection)'}${notes}`;
      });

      return {
        content: `The user answered:\n${lines.join('\n')}`,
        metadata: { answers },
      };
    },
  };
}

/** Upstream `UNIQUENESS_REFINE`: question texts and option labels must be unique. */
function assertUnique(questions: readonly Question[]): void {
  const texts = questions.map((question) => question.question);
  if (new Set(texts).size !== texts.length) {
    throw new AgentHarnessError('Question texts must be unique', 'QUESTION_NOT_UNIQUE');
  }
  for (const question of questions) {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      throw new AgentHarnessError(
        `Option labels must be unique within "${question.question}"`,
        'OPTION_NOT_UNIQUE',
      );
    }
    if (labels.some((label) => label.trim().toLowerCase() === OTHER_OPTION_LABEL.toLowerCase())) {
      throw new AgentHarnessError(
        `Do not supply an "${OTHER_OPTION_LABEL}" option; it is added automatically`,
        'OPTION_RESERVED',
      );
    }
  }
}

/**
 * Handler that answers with the first option of every question. Intended for
 * tests and for non-interactive runs where hanging is worse than guessing.
 */
export class FirstOptionQuestionHandler implements UserQuestionHandler {
  async ask(request: UserQuestionRequest): Promise<readonly UserQuestionAnswer[]> {
    return request.questions.map((question) => ({
      question: question.question,
      selected: [question.options[0]?.label ?? ''],
    }));
  }
}
