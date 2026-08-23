/**
 * Rendering a `ContextState` back into text the model reads.
 *
 * Deliberately not prose. A narrative summary ("the user asked about X, then we
 * tried Y") reads well and is nearly useless to the next turn: the model has to
 * re-infer what is still true from a story about what happened. A structured block
 * states it instead, under headings the parser in `context-state.ts` can read back
 * on the turn after — which is what makes a constraint survive its fourth
 * compaction rather than being paraphrased into vagueness and then dropped.
 *
 * Two rules the renderer keeps:
 *
 * - **Superseded information is never presented as current.** It gets its own
 *   `SUPERSEDED` section, last, so the model knows those choices were overruled
 *   rather than re-applying them.
 * - **Every render fits the ceiling it was given.** Sections are filled in priority
 *   order and the whole result is clamped, so the caller that sized the allowance
 *   does not have to check the answer.
 */
import {
  CONTEXT_STATE_SECTIONS,
  type ContextState,
  type ContextStateItem,
} from './context-state.js';
import type { AgentMessage } from '../core/messages.js';

/**
 * Which sections matter most when the ceiling is too small for all of them.
 *
 * The order is the protection order the orchestrator applies everywhere else: what
 * the user asked for, what they forbade, what was decided, what is still broken,
 * what is left to do. `RECENT ACTIONS` and `COMPLETED` are last because the
 * verbatim tail usually still contains them.
 */
const SECTION_PRIORITY: readonly string[] = [
  'CURRENT GOAL',
  'CONSTRAINTS',
  'ACTIVE TASK',
  'ACTIVE DECISIONS',
  'ERRORS',
  'PENDING',
  'UNRESOLVED QUESTIONS',
  'IMPORTANT FILES',
  'RELEVANT FACTS',
  'ARTIFACTS',
  'SUPERSEDED',
  'TOOL STATE',
  'COMPLETED',
  'RECENT ACTIONS',
];

/**
 * Renders the state as a bounded, structured block.
 *
 * @param maxChars Hard ceiling. The result is never longer, headings included.
 */
export function renderContextState(state: ContextState, maxChars: number): string {
  const ceiling = Math.max(120, Math.floor(maxChars));
  const sections = new Map<string, readonly ContextStateItem[]>();

  for (const section of CONTEXT_STATE_SECTIONS) {
    const value = itemsForSection(state, section.field);
    if (value.length > 0) sections.set(section.title, value);
  }

  const lines: string[] = [];
  let used = 0;
  for (const title of SECTION_PRIORITY) {
    const items = sections.get(title);
    if (!items || items.length === 0) continue;
    const header = `${title}:`;
    if (used + header.length + 1 > ceiling) break;
    const body: string[] = [];
    let sectionUsed = header.length + 1;
    for (const entry of items) {
      const line = `- ${entry.text}`;
      if (used + sectionUsed + line.length + 1 > ceiling) break;
      body.push(line);
      sectionUsed += line.length + 1;
    }
    if (body.length === 0) continue;
    lines.push(header, ...body, '');
    used += sectionUsed + 1;
  }

  return lines.join('\n').trimEnd().slice(0, ceiling);
}

/**
 * The structured state plus a short digest of the conversation it replaces.
 *
 * The state says what is true; the digest says what was said, which is what keeps a
 * summary readable when the state derivation found little to name — a long
 * exploratory conversation with no explicit constraints, for instance. The state
 * gets the larger share because it is the part the next turn depends on.
 */
export function renderStateSummary(
  state: ContextState,
  messages: readonly AgentMessage[],
  maxChars: number,
): string {
  const ceiling = Math.max(200, Math.floor(maxChars));
  const stateBlock = renderContextState(state, Math.floor(ceiling * 0.75));
  const remaining = ceiling - stateBlock.length - 40;
  const digest = remaining > 120 ? conversationDigest(messages, remaining) : '';
  return [stateBlock, digest]
    .filter((part) => part.trim() !== '')
    .join('\n\n')
    .slice(0, ceiling);
}

/**
 * A compressed trace of what happened, for the part of a conversation that has no
 * state to name.
 *
 * Roles and first words only, tool calls by name, tool results by outcome. Errors
 * are kept longer than successes because an error that still applies is the thing a
 * next turn most needs to not repeat.
 */
export function conversationDigest(messages: readonly AgentMessage[], maxChars: number): string {
  const lines: string[] = ['EARLIER CONVERSATION:'];
  let used = lines[0]!.length;
  for (const message of messages) {
    for (const block of message.content) {
      let line: string | undefined;
      if (block.type === 'text') {
        const snippet = block.text.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (snippet) line = `- ${message.role}: ${snippet}`;
      } else if (block.type === 'tool_call') {
        line = `- called ${block.name}`;
      } else if (block.type === 'tool_result') {
        line = block.isError
          ? `- ${'error'}: ${block.content.replace(/\s+/g, ' ').slice(0, 200)}`
          : `- result ok (${block.content.length.toLocaleString()} chars)`;
      } else if (block.type === 'image') {
        line = `- image: ${block.filename ?? block.mediaType}`;
      }
      if (!line) continue;
      if (used + line.length + 1 > maxChars) return lines.join('\n');
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function itemsForSection(state: ContextState, field: string): readonly ContextStateItem[] {
  switch (field) {
    case 'currentGoal':
      return state.currentGoal ? [state.currentGoal] : [];
    case 'activeTask':
      // Suppressed when it is simply the goal restated: two identical headings say
      // less than one.
      return state.activeTask && state.activeTask.text !== state.currentGoal?.text
        ? [state.activeTask]
        : [];
    case 'constraints':
      return state.constraints;
    case 'decisions':
      return state.decisions;
    case 'supersededDecisions':
      return state.supersededDecisions;
    case 'pending':
      return state.pending;
    case 'completed':
      return state.completed;
    case 'questions':
      return state.questions;
    case 'errors':
      return state.errors;
    case 'files':
      return state.files;
    case 'artifacts':
      return state.artifacts;
    case 'toolState':
      return state.toolState;
    case 'facts':
      return state.facts;
    case 'recentActions':
      return state.recentActions;
    default:
      return [];
  }
}
