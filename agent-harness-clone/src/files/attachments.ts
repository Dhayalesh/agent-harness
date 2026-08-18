import type { ImageBlock } from '../core/messages.js';
import type { InvocationAttachment } from '../headless/payload.js';

/**
 * Turns a payload's attachments into model input.
 *
 * Two routes, because models are not uniform. Text — including anything a caller
 * extracted from a spreadsheet or a Word document — is folded into the prompt as a
 * delimited section, which every model can read. Images become content blocks,
 * which only a vision model can read.
 *
 * The caller does the extracting. Bytes for a large workbook cannot cross an 8 MB
 * JSON body, and re-parsing the same file on every turn of a conversation would pay
 * that cost repeatedly; a caller that extracts once sends a few KB of text instead.
 */

export type PreparedAttachments = {
  /** The prompt the model receives, with any text attachments prepended. */
  prompt: string;
  images: ImageBlock[];
  /** One line per attachment, for logging what a turn was given. */
  summary: string[];
};

const OPEN = '<attached_files>';
const CLOSE = '</attached_files>';

export function prepareAttachments(
  attachments: readonly InvocationAttachment[],
  prompt: string,
): PreparedAttachments {
  if (!attachments.length) return { prompt, images: [], summary: [] };

  const images: ImageBlock[] = [];
  const sections: string[] = [];
  const summary: string[] = [];

  for (const attachment of attachments) {
    summary.push(
      `${attachment.filename} (${attachment.contentType}, ${attachment.kind}` +
        `${attachment.size === undefined ? '' : `, ${attachment.size} bytes`})`,
    );
    if (attachment.kind === 'image') {
      images.push({
        type: 'image',
        mediaType: attachment.contentType,
        data: attachment.data ?? '',
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
      continue;
    }
    sections.push(textSection(attachment));
  }

  // Images are named in the prompt as well as sent as blocks. Without this a model
  // asked about "the second screenshot" has no way to know which block that is.
  if (images.length) {
    sections.push(
      `<image name=${quote(images.map((image) => image.filename ?? 'image').join(', '))} />`,
    );
  }

  const preamble = sections.length ? `${OPEN}\n${sections.join('\n')}\n${CLOSE}\n\n` : '';
  const trimmed = prompt.trim();
  return {
    // A files-only turn still needs an instruction, or the model is left guessing
    // whether it is meant to summarise, review, or wait for a follow-up.
    prompt: `${preamble}${trimmed || FILES_ONLY_PROMPT}`,
    images,
    summary,
  };
}

const FILES_ONLY_PROMPT =
  'The user sent these files with no message. Briefly describe what each one ' +
  'contains and ask what they would like done with them.';

function textSection(attachment: InvocationAttachment): string {
  const attributes = [
    `name=${quote(attachment.filename)}`,
    `type=${quote(attachment.contentType)}`,
    ...(attachment.language ? [`language=${quote(attachment.language)}`] : []),
    ...(attachment.notes?.length ? [`note=${quote(attachment.notes.join('; '))}`] : []),
  ].join(' ');
  // Fenced inside the tag so a file that itself contains `</file>` cannot close
  // the section early, and so the model treats the body as data, not instructions.
  return `<file ${attributes}>\n${fence(attachment.text ?? '')}\n</file>`;
}

/**
 * A fence long enough to survive the file's own backticks.
 *
 * A Markdown upload containing a triple-backtick block would otherwise terminate
 * the fence early and spill the rest of the file into the prompt as instructions.
 */
function fence(body: string): string {
  const longest = [...body.matchAll(/`{3,}/g)].reduce(
    (length, match) => Math.max(length, match[0].length),
    2,
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${body}\n${ticks}`;
}

function quote(value: string): string {
  return `"${value.replace(/[\x00-\x1F\x7F]/g, ' ').replaceAll('"', "'")}"`;
}
