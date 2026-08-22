/**
 * Automatic control of tool output.
 *
 * Tool results are where a context actually fills up. A conversation grows a few
 * hundred tokens a turn; one `read_file` on a lockfile or one `bash` that cats a log
 * grows it by a hundred thousand. The existing manager already trims anything over
 * `maxToolResultTokens` head-and-tail, which is the right mechanism — this module
 * keeps that mechanism and removes the two things wrong with applying it flatly:
 *
 * 1. **The allowance was a configured number.** It is derived here from the
 *    effective input budget and the number of results competing for it, so a 1 M
 *    window is not held to a limit chosen for a 128 K one, and an agent never has to
 *    name a token count.
 * 2. **Every result was treated the same.** A stack trace, a JSON document, the
 *    fortieth identical directory listing and a 4 MB minified bundle are not
 *    interchangeable. They are classified, and the allowance follows the class:
 *    errors get more room than successes, duplicates get a pointer instead of a
 *    copy, and unreferenced old output gets the least.
 *
 * What does not change: a `tool_result` block is never removed, never re-ordered,
 * and never separated from its `tool_call`. Only the *content* of a block is
 * shortened, so the protocol shape the provider validates is identical before and
 * after.
 */
import type { AgentMessage, ToolResultBlock } from '../core/messages.js';
import { trimToolResultText, type ContextPressure } from './context-manager.js';
import { RECENT_WINDOW_MESSAGES, type ContextState } from './context-state.js';

/**
 * What kind of output a result is, which decides how much room it keeps.
 *
 * `duplicate` is the only class whose content is replaced rather than shortened: an
 * exact repeat of a later result carries no information the later copy does not, so
 * a pointer to it is lossless in a way that trimming never is.
 */
export type ToolResultClass = 'error' | 'structured' | 'important' | 'duplicate' | 'irrelevant';

export type ToolResultDecision = {
  messageIndex: number;
  toolCallId: string;
  toolName: string;
  classification: ToolResultClass;
  action: 'kept' | 'trimmed' | 'deduplicated';
  originalChars: number;
  keptChars: number;
};

export type ToolResultManagement = {
  /** The input array by reference when nothing needed changing. */
  messages: readonly AgentMessage[];
  /** How many results were shortened. */
  trimmed: number;
  /** How many were replaced by a pointer to an identical later result. */
  deduplicated: number;
  decisions: readonly ToolResultDecision[];
};

/** Characters per token, matching the estimator. */
const CHARS_PER_TOKEN = 4;

/**
 * The share of the input budget all tool output together may occupy.
 *
 * Tightened as pressure rises: at `aggressive` there is still room to be generous,
 * at `critical` the conversation itself needs the space back. These are not settings
 * — they are the point of the module, and exposing them would mean an agent could
 * configure its way back into the failure this exists to prevent.
 */
const TOTAL_SHARE: Record<ContextPressure, number> = {
  nominal: 0.6,
  warning: 0.55,
  aggressive: 0.45,
  critical: 0.3,
};

/** How each class's allowance relates to the even split. */
const CLASS_WEIGHT: Record<ToolResultClass, number> = {
  // A truncated error is a debugging dead end, and an error that still applies is
  // the single most valuable thing in a tool result.
  error: 2,
  // Structured output is usually consumed whole or not at all; half a JSON document
  // is not parseable, so it is worth keeping more of.
  structured: 1.25,
  important: 1,
  duplicate: 0,
  irrelevant: 0.5,
};

/** No result is ever cut below this, whatever the arithmetic says. */
const FLOOR_TOKENS: Record<ToolResultClass, number> = {
  error: 500,
  structured: 300,
  important: 250,
  duplicate: 0,
  irrelevant: 150,
};

/**
 * Brings tool output inside a share of the budget, class by class.
 *
 * @param options.effectiveInputBudget The turn's derived input budget.
 * @param options.pressure How full the context is, which sets the total share.
 * @param options.state The derived state, used to tell referenced output from
 *   forgotten output. Optional: without it every result is treated as `important`,
 *   which is the safe direction to be wrong in.
 */
export function manageToolResults(
  messages: readonly AgentMessage[],
  options: {
    effectiveInputBudget: number;
    pressure: ContextPressure;
    state?: ContextState;
  },
): ToolResultManagement {
  const blocks = collectResults(messages);
  if (blocks.length === 0) return { messages, trimmed: 0, deduplicated: 0, decisions: [] };

  const totalAllowanceChars =
    Math.max(1, Math.floor(options.effectiveInputBudget * TOTAL_SHARE[options.pressure])) *
    CHARS_PER_TOKEN;
  const evenSplit = Math.floor(totalAllowanceChars / blocks.length);

  const activeFiles = (options.state?.files ?? []).map((file) => file.text.toLowerCase());
  const recentFrom = messages.length - RECENT_WINDOW_MESSAGES;

  // Duplicate detection runs newest-first so the copy that is kept verbatim is the
  // most recent one — the one the next turn is most likely to be reasoning about.
  const lastByFingerprint = new Map<string, number>();
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const entry = blocks[i];
    if (!entry) continue;
    const fingerprint = fingerprint_(entry.block);
    if (fingerprint === undefined) continue;
    if (!lastByFingerprint.has(fingerprint)) lastByFingerprint.set(fingerprint, i);
  }

  const decisions: ToolResultDecision[] = [];
  const replacements = new Map<string, string>();
  let trimmed = 0;
  let deduplicated = 0;

  blocks.forEach((entry, position) => {
    const { block, messageIndex, toolName } = entry;
    const fingerprint = fingerprint_(block);
    const newest = fingerprint === undefined ? undefined : lastByFingerprint.get(fingerprint);
    const classification: ToolResultClass = block.isError
      ? 'error'
      : newest !== undefined && newest !== position
        ? 'duplicate'
        : isStructured(block.content)
          ? 'structured'
          : messageIndex >= recentFrom || referencesActiveFile(block.content, activeFiles)
            ? 'important'
            : 'irrelevant';

    if (classification === 'duplicate') {
      const pointer = `[Identical to a later result of ${toolName}; the duplicate copy was removed to fit the context. ${block.content.length.toLocaleString()} characters.]`;
      // Only worth doing when the pointer is actually smaller. Two short identical
      // results cost less than two notices explaining that they were identical.
      if (pointer.length < block.content.length) {
        replacements.set(key(entry), pointer);
        deduplicated += 1;
        decisions.push({
          messageIndex,
          toolCallId: block.toolCallId,
          toolName,
          classification,
          action: 'deduplicated',
          originalChars: block.content.length,
          keptChars: pointer.length,
        });
        return;
      }
    }

    const allowance = Math.max(
      FLOOR_TOKENS[classification] * CHARS_PER_TOKEN,
      Math.floor(evenSplit * CLASS_WEIGHT[classification]),
    );
    if (block.content.length <= allowance) {
      decisions.push({
        messageIndex,
        toolCallId: block.toolCallId,
        toolName,
        classification,
        action: 'kept',
        originalChars: block.content.length,
        keptChars: block.content.length,
      });
      return;
    }
    const shortened = trimToolResultText(block.content, allowance);
    replacements.set(key(entry), shortened);
    trimmed += 1;
    decisions.push({
      messageIndex,
      toolCallId: block.toolCallId,
      toolName,
      classification,
      action: 'trimmed',
      originalChars: block.content.length,
      keptChars: shortened.length,
    });
  });

  if (replacements.size === 0) {
    return { messages, trimmed: 0, deduplicated: 0, decisions };
  }

  // Rebuilt rather than mutated: the array handed in belongs to the caller, and for
  // `AgentSession` it is a clone of the canonical history that must stay intact.
  const next = messages.map((message, messageIndex) => {
    if (!message.content.some((block) => block.type === 'tool_result')) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const replacement = replacements.get(`${messageIndex}:${block.toolCallId}`);
      if (replacement === undefined) return block;
      changed = true;
      return { ...block, content: replacement };
    });
    return changed ? { ...message, content } : message;
  });

  return { messages: next, trimmed, deduplicated, decisions };
}

type CollectedResult = {
  block: ToolResultBlock;
  messageIndex: number;
  toolName: string;
};

function collectResults(messages: readonly AgentMessage[]): CollectedResult[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') names.set(block.id, block.name);
    }
  }
  const out: CollectedResult[] = [];
  messages.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      out.push({ block, messageIndex, toolName: names.get(block.toolCallId) ?? 'tool' });
    }
  });
  return out;
}

function key(entry: CollectedResult): string {
  return `${entry.messageIndex}:${entry.block.toolCallId}`;
}

/**
 * Whether the content is a document rather than a transcript.
 *
 * Parsed rather than pattern-matched: a log line that happens to start with `{` is
 * not structured output, and treating it as such would hand it a larger allowance
 * than it earns.
 */
function isStructured(content: string): boolean {
  const trimmedContent = content.trim();
  if (!/^[[{]/.test(trimmedContent)) return false;
  // Parsing megabytes to answer a classification question is not worth it; the first
  // and last characters agreeing is enough evidence at that size.
  if (trimmedContent.length > 200_000) {
    return /[\]}]$/.test(trimmedContent);
  }
  try {
    JSON.parse(trimmedContent);
    return true;
  } catch {
    return false;
  }
}

function referencesActiveFile(content: string, activeFiles: readonly string[]): boolean {
  if (activeFiles.length === 0) return false;
  const head = content.slice(0, 4_000).toLowerCase();
  return activeFiles.some((file) => head.includes(file));
}

/** Identical content, normalised. `undefined` when too short to be worth a pointer. */
function fingerprint_(block: ToolResultBlock): string | undefined {
  const normalized = block.content.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized.length < 400 ? undefined : `${block.isError ? 'e' : 'o'}:${normalized}`;
}
