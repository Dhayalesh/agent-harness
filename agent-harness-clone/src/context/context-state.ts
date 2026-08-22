/**
 * What the conversation is *about*, derived rather than stored.
 *
 * The compaction machinery in `context-manager.ts` reasons in tokens: it knows how
 * much a message costs and nothing about what it says. That is the right level for
 * a budget and the wrong level for a decision about what may be thrown away. This
 * module is the missing half — a bounded, machine-readable reading of the current
 * goal, the constraints the user stated, the decisions that are still in force, the
 * ones that have been overruled, the work outstanding, and the errors that still
 * matter.
 *
 * Three properties are deliberate:
 *
 * 1. **Derived, never stored.** `deriveContextState` is a pure function of the
 *    canonical history. Nothing here is persisted, so it cannot drift out of step
 *    with the conversation and there is no second source of truth to reconcile.
 * 2. **Deterministic.** No model call. Context safety decisions run on every turn
 *    and must not depend on a network hop that can fail, stall, or hallucinate a
 *    constraint the user never wrote.
 * 3. **Bounded.** Every item is a short, whitespace-collapsed excerpt and every
 *    category has a hard cap, so the state of a 500-turn conversation is the same
 *    order of magnitude as the state of a 5-turn one.
 *
 * The state a previous compaction wrote back into the transcript is parsed out of
 * it again (`CONTEXT_STATE_SECTIONS`), which is what lets a constraint stated on
 * turn 2 survive the fourth compaction rather than being summarised, re-summarised,
 * and finally lost.
 */
import type { AgentMessage } from '../core/messages.js';

/**
 * Whether a piece of information still governs the work.
 *
 * The distinction `active` / `superseded` is the one that matters most: a decision
 * that was overruled is not merely old, it is *wrong*, and preserving it as current
 * state is worse than dropping it. `irrelevant` exists so the selector has a name
 * for what it is allowed to discard first.
 */
export type ContextItemStatus = 'active' | 'superseded' | 'completed' | 'pending' | 'irrelevant';

/** What kind of thing an item is, which is what decides how hard it is protected. */
export type ContextItemKind =
  | 'goal'
  | 'task'
  | 'constraint'
  | 'decision'
  | 'question'
  | 'error'
  | 'file'
  | 'artifact'
  | 'tool-state'
  | 'action'
  | 'fact';

export type ContextStateItem = {
  kind: ContextItemKind;
  status: ContextItemStatus;
  /** A short, whitespace-collapsed excerpt. Never a raw payload. */
  text: string;
  /** Index into the canonical message array this was read from, or -1 when it was recovered from a summary. */
  messageIndex: number;
  /** The message id it came from, for correlation only. */
  messageId?: string;
};

export type ContextState = {
  /** What the user last asked for. The one thing that is never compressed away. */
  currentGoal?: ContextStateItem;
  /** The unit of work in progress, which is the goal until something narrower is outstanding. */
  activeTask?: ContextStateItem;
  taskProgress: { completed: number; pending: number };
  /** Explicit user instructions and prohibitions. Protected at the same level as the goal. */
  constraints: readonly ContextStateItem[];
  /** Choices still in force. */
  decisions: readonly ContextStateItem[];
  /** Choices that a later choice or a user correction overruled. Recorded so they are not re-applied. */
  supersededDecisions: readonly ContextStateItem[];
  pending: readonly ContextStateItem[];
  completed: readonly ContextStateItem[];
  questions: readonly ContextStateItem[];
  /** Failures that still affect the work; a failure a later success cleared is `completed`. */
  errors: readonly ContextStateItem[];
  files: readonly ContextStateItem[];
  artifacts: readonly ContextStateItem[];
  toolState: readonly ContextStateItem[];
  recentActions: readonly ContextStateItem[];
  facts: readonly ContextStateItem[];
  /**
   * Which messages carry state worth protecting, and which kinds.
   *
   * The selector and the importance ranker both need this, and computing it here —
   * once, while the derivation is already walking the messages — is cheaper and
   * less error-prone than each of them re-deriving it from the item lists.
   */
  carriers: ReadonlyMap<number, readonly ContextItemKind[]>;
};

/** The marker the orchestrator writes in front of an injected state block. */
export const CONTEXT_STATE_MARKER = '[Context state]';

/** The marker compaction writes in front of a summary. Matches `context-manager.ts`. */
export const COMPACTION_MARKER = '[Compacted earlier conversation]';

/**
 * The section headings a rendered state uses, and what each one means when read
 * back out of a transcript.
 *
 * Shared by the renderer and the parser on purpose: a heading that only one of them
 * knows is a category that silently stops surviving compaction.
 */
export const CONTEXT_STATE_SECTIONS: readonly {
  title: string;
  kind: ContextItemKind;
  status: ContextItemStatus;
  field: keyof ContextState | 'currentGoal' | 'activeTask';
}[] = [
  { title: 'CURRENT GOAL', kind: 'goal', status: 'active', field: 'currentGoal' },
  { title: 'ACTIVE TASK', kind: 'task', status: 'active', field: 'activeTask' },
  { title: 'CONSTRAINTS', kind: 'constraint', status: 'active', field: 'constraints' },
  { title: 'ACTIVE DECISIONS', kind: 'decision', status: 'active', field: 'decisions' },
  { title: 'COMPLETED', kind: 'task', status: 'completed', field: 'completed' },
  { title: 'PENDING', kind: 'task', status: 'pending', field: 'pending' },
  { title: 'UNRESOLVED QUESTIONS', kind: 'question', status: 'pending', field: 'questions' },
  { title: 'ERRORS', kind: 'error', status: 'active', field: 'errors' },
  { title: 'IMPORTANT FILES', kind: 'file', status: 'active', field: 'files' },
  { title: 'RELEVANT FACTS', kind: 'fact', status: 'active', field: 'facts' },
  { title: 'ARTIFACTS', kind: 'artifact', status: 'active', field: 'artifacts' },
  { title: 'TOOL STATE', kind: 'tool-state', status: 'active', field: 'toolState' },
  { title: 'RECENT ACTIONS', kind: 'action', status: 'active', field: 'recentActions' },
  { title: 'SUPERSEDED', kind: 'decision', status: 'superseded', field: 'supersededDecisions' },
];

/** How much of one item is kept. Enough to identify it, never enough to be a payload. */
const ITEM_CHARS = 240;

/** Per-category caps. State must not grow with the conversation. */
const CAPS = {
  constraints: 12,
  decisions: 12,
  supersededDecisions: 8,
  pending: 10,
  completed: 10,
  questions: 8,
  errors: 8,
  files: 20,
  artifacts: 8,
  toolState: 8,
  recentActions: 8,
  facts: 6,
} as const;

/** How many messages count as "recent" when deciding whether a fact is still live. */
export const RECENT_WINDOW_MESSAGES = 8;

// ---------------------------------------------------------------------------
// Language markers
//
// Regexes rather than a model: these run on every turn, and a context decision
// that depends on a network call is a context decision that fails when the network
// does. They are intentionally generous — over-protecting a sentence costs a few
// tokens, while missing a constraint costs the user their instruction.
// ---------------------------------------------------------------------------

const CONSTRAINT_MARKER =
  /\b(must|mustn't|must not|do not|don't|never|always|only|ensure|require[sd]?|avoid|make sure|cannot|can't|should not|shouldn't|no longer|keep|preserve|without|instead of|at most|at least|no more than)\b/i;

const DECISION_MARKER =
  /\b(i'?ll|i will|we'?ll|we will|let'?s|going to|decided|deciding|decision|chose|chosen|choosing|switch(?:ing|ed)? to|plan is|approach is|using|use|opted?|settled on)\b/i;

const CORRECTION_MARKER =
  /\b(actually|instead|scrap|revert|undo|change (?:it |that )?to|no,|forget|rather than|don'?t use|stop using|switch(?:ed)? to|on second thought|correction)\b/i;

const PENDING_MARKER =
  /\b(todo|to-do|next step|next,|next:|still need|still needs|remaining|pending|not yet|will need|after that|then i'?ll|outstanding|left to do)\b/i;

const COMPLETED_MARKER =
  /\b(done|completed|finished|fixed|created|added|implemented|passed|works now|resolved|shipped|merged|verified)\b/i;

const FACT_MARKER =
  /\b(is at|lives in|located|version|endpoint|url|port|database|table|schema|credential|region|bucket|branch|repo(?:sitory)?|package|module)\b/i;

/**
 * Path-like tokens.
 *
 * Two alternatives rather than one: a POSIX or Windows path with a separator, and a
 * bare filename with a recognisable extension. A bare filename is how a user names
 * a file in prose ("fix agent-session.ts"), and it is exactly the reference that
 * has to keep the earlier discussion of that file alive.
 */
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z]{1,8}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cs|rb|php|sql|ya?ml|toml|css|scss|html|sh|ps1|txt|csv|env)\b/g;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Reads the current state of the work out of the conversation.
 *
 * Pure and side-effect free: the same messages always produce the same state, and
 * the messages are never touched.
 */
export function deriveContextState(messages: readonly AgentMessage[]): ContextState {
  const carriers = new Map<number, ContextItemKind[]>();
  const note = (index: number, kind: ContextItemKind): void => {
    const existing = carriers.get(index);
    if (existing === undefined) carriers.set(index, [kind]);
    else if (!existing.includes(kind)) existing.push(kind);
  };

  const constraints: ContextStateItem[] = [];
  const decisions: ContextStateItem[] = [];
  const pending: ContextStateItem[] = [];
  const completed: ContextStateItem[] = [];
  const questions: ContextStateItem[] = [];
  const errors: ContextStateItem[] = [];
  const files = new Map<string, ContextStateItem>();
  const artifacts: ContextStateItem[] = [];
  const facts: ContextStateItem[] = [];
  const recentActions: ContextStateItem[] = [];
  const toolState = new Map<string, ContextStateItem>();
  const recovered: ContextStateItem[] = [];

  const callNames = new Map<string, string>();
  /** Tool names that produced a successful result after their last failure. */
  const laterSuccess = new Map<string, number>();
  const failures: { item: ContextStateItem; tool: string; index: number }[] = [];

  let currentGoal: ContextStateItem | undefined;
  let lastUserIndex = -1;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const text = textOf(message);
    const isRecovery =
      text.startsWith(CONTEXT_STATE_MARKER) || text.startsWith(COMPACTION_MARKER);

    // A block written by an earlier compaction. Read it back rather than treating it
    // as ordinary prose, so state that has already been distilled once is not
    // distilled again into something vaguer.
    if (isRecovery) {
      for (const item of parseRenderedState(text)) {
        recovered.push({ ...item, messageIndex: index, ...(message.id ? { messageId: message.id } : {}) });
        note(index, item.kind);
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'tool_call') {
        callNames.set(block.id, block.name);
        const preview = previewOf(block.input);
        recentActions.push(item('action', 'active', `${block.name}(${preview})`, index, message.id));
        toolState.set(block.name, item('tool-state', 'active', `${block.name}: requested`, index, message.id));
        if (/artifact|document|spreadsheet|markdown|html|csv|code/i.test(block.name)) {
          artifacts.push(item('artifact', 'active', `${block.name} ${preview}`, index, message.id));
          note(index, 'artifact');
        }
        for (const path of pathsIn(preview)) {
          files.set(path, item('file', 'active', path, index, message.id));
          note(index, 'file');
        }
        note(index, 'action');
        continue;
      }
      if (block.type === 'tool_result') {
        const tool = callNames.get(block.toolCallId) ?? 'tool';
        if (block.isError) {
          const failure = item(
            'error',
            'active',
            `${tool}: ${block.content}`,
            index,
            message.id,
          );
          failures.push({ item: failure, tool, index });
          toolState.set(tool, item('tool-state', 'active', `${tool}: failed`, index, message.id));
          note(index, 'error');
        } else {
          laterSuccess.set(tool, index);
          toolState.set(tool, item('tool-state', 'active', `${tool}: ok`, index, message.id));
        }
        for (const path of pathsIn(block.content.slice(0, 2_000))) {
          files.set(path, item('file', 'active', path, index, message.id));
          note(index, 'file');
        }
        continue;
      }
      if (block.type !== 'text') continue;

      for (const path of pathsIn(block.text)) {
        files.set(path, item('file', 'active', path, index, message.id));
        note(index, 'file');
      }

      for (const sentence of sentencesOf(block.text)) {
        if (message.role === 'user') {
          lastUserIndex = index;
          if (CONSTRAINT_MARKER.test(sentence)) {
            constraints.push(item('constraint', 'active', sentence, index, message.id));
            note(index, 'constraint');
          }
          if (sentence.endsWith('?')) {
            questions.push(item('question', 'pending', sentence, index, message.id));
            note(index, 'question');
          }
          if (
            FACT_MARKER.test(sentence) &&
            !CONSTRAINT_MARKER.test(sentence) &&
            !CORRECTION_MARKER.test(sentence)
          ) {
            facts.push(item('fact', 'active', sentence, index, message.id));
          }
          if (CORRECTION_MARKER.test(sentence)) {
            supersedeMatching(decisions, sentence);
            // A statement the user corrected must not survive as a standing fact
            // either. "Use MySQL" filed under decisions and overruled, then restated
            // under facts as though it still held, is the same failure with a
            // different heading on it.
            supersedeMatching(facts, sentence);
          }
          continue;
        }
        // Assistant prose. Decisions and progress reports live here.
        if (DECISION_MARKER.test(sentence)) {
          supersedeMatching(decisions, sentence);
          decisions.push(item('decision', 'active', sentence, index, message.id));
          note(index, 'decision');
        }
        if (PENDING_MARKER.test(sentence)) {
          pending.push(item('task', 'pending', sentence, index, message.id));
          note(index, 'task');
        }
        if (COMPLETED_MARKER.test(sentence)) {
          completed.push(item('task', 'completed', sentence, index, message.id));
        }
      }
    }

    if (message.role === 'user' && text.trim() !== '') {
      const goal = firstSentence(text);
      if (goal) {
        currentGoal = item('goal', 'active', goal, index, message.id);
        note(index, 'goal');
      }
    }
  }

  // A failure a later run of the same tool cleared is history, not a live problem.
  for (const failure of failures) {
    const cleared = laterSuccess.get(failure.tool);
    if (cleared !== undefined && cleared > failure.index) {
      completed.push({ ...failure.item, status: 'completed' });
    } else {
      errors.push(failure.item);
    }
  }

  // A question the assistant went on to answer is not outstanding. "Answered" is
  // approximated by "the assistant wrote prose after it", which is the honest
  // reading available without asking a model.
  const answered = (question: ContextStateItem): boolean =>
    messages.some(
      (message, index) =>
        index > question.messageIndex &&
        message.role === 'assistant' &&
        textOf(message).trim().length > 0,
    );

  const partial = {
    constraints: mergeRecovered(dedupe(constraints), recovered, 'constraint', 'active').slice(
      -CAPS.constraints,
    ),
    decisions: mergeRecovered(
      dedupe(decisions.filter((entry) => entry.status === 'active')),
      recovered,
      'decision',
      'active',
    ).slice(-CAPS.decisions),
    supersededDecisions: mergeRecovered(
      dedupe(decisions.filter((entry) => entry.status === 'superseded')),
      recovered,
      'decision',
      'superseded',
    ).slice(-CAPS.supersededDecisions),
    pending: mergeRecovered(dedupe(pending), recovered, 'task', 'pending').slice(-CAPS.pending),
    completed: mergeRecovered(dedupe(completed), recovered, 'task', 'completed').slice(
      -CAPS.completed,
    ),
    questions: mergeRecovered(
      dedupe(questions.filter((question) => !answered(question))),
      recovered,
      'question',
      'pending',
    ).slice(-CAPS.questions),
    errors: mergeRecovered(dedupe(errors), recovered, 'error', 'active').slice(-CAPS.errors),
    files: mergeRecovered([...files.values()], recovered, 'file', 'active').slice(-CAPS.files),
    artifacts: mergeRecovered(dedupe(artifacts), recovered, 'artifact', 'active').slice(
      -CAPS.artifacts,
    ),
    toolState: [...toolState.values()].slice(-CAPS.toolState),
    recentActions: recentActions.slice(-CAPS.recentActions),
    facts: mergeRecovered(
      dedupe(facts.filter((entry) => entry.status === 'active')),
      recovered,
      'fact',
      'active',
    ).slice(-CAPS.facts),
    carriers,
  };

  // A goal that only survives inside an earlier summary is still the goal.
  const goal =
    currentGoal ?? recovered.find((entry) => entry.kind === 'goal' && entry.status === 'active');

  // The task in progress is the outstanding work when there is any, and the goal
  // itself otherwise. Naming it separately is what lets the selector protect "what
  // we are doing now" even on a turn where the user said nothing new.
  const lastPending = partial.pending[partial.pending.length - 1];
  const activeTask: ContextStateItem | undefined = lastPending
    ? { ...lastPending, kind: 'task', status: 'pending' }
    : goal
      ? { ...goal, kind: 'task' }
      : undefined;

  void lastUserIndex;

  return {
    ...partial,
    ...(goal ? { currentGoal: goal } : {}),
    ...(activeTask ? { activeTask } : {}),
    taskProgress: { completed: partial.completed.length, pending: partial.pending.length },
  };
}

/**
 * Reads items back out of a state block a previous turn wrote.
 *
 * Exported for the verifier, which has to be able to tell that a constraint is
 * still represented in a prepared context even when the only remaining copy of it
 * is inside a summary.
 */
export function parseRenderedState(text: string): ContextStateItem[] {
  const items: ContextStateItem[] = [];
  const lines = text.split('\n');
  let section: (typeof CONTEXT_STATE_SECTIONS)[number] | undefined;
  for (const line of lines) {
    const heading = line.trim().replace(/:$/, '');
    const matched = CONTEXT_STATE_SECTIONS.find((candidate) => candidate.title === heading);
    if (matched) {
      section = matched;
      continue;
    }
    if (!section) continue;
    const body = line.replace(/^\s*[-*]\s*/, '').trim();
    if (body === '') continue;
    if (/^[A-Z][A-Z ]+:?$/.test(body)) {
      section = undefined;
      continue;
    }
    items.push({
      kind: section.kind,
      status: section.status,
      text: body.slice(0, ITEM_CHARS),
      messageIndex: -1,
    });
  }
  return items;
}

/** The words of a text worth matching on, lowercased and de-noised. */
export function significantWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Dots, slashes and dashes are kept inside a word so `agent-session.ts` and
      // `src/context/state.ts` stay single tokens — a file path is the most useful
      // thing this function can match on.
      .split(/[^a-z0-9_./\\-]+/)
      // Then stripped from the edges, because sentence punctuation is not part of a
      // word. Leaving it on is subtle and expensive: `database.` and `database` stop
      // matching, so a corrected statement is no longer recognised as being about the
      // same subject as the correction, and it survives as though it still held.
      .map((word) => word.replace(/^[.\-/\\]+/, '').replace(/[.\-/\\]+$/, ''))
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
  );
}

const STOP_WORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'they',
  'them',
  'then',
  'than',
  'been',
  'when',
  'what',
  'your',
  'about',
  'would',
  'could',
  'should',
  'there',
  'their',
  'which',
  'because',
  'while',
  'into',
  'also',
  'just',
  'like',
  'make',
  'made',
  'need',
  'want',
  'more',
  'some',
  'only',
  'over',
  'here',
  'does',
  'done',
]);

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function item(
  kind: ContextItemKind,
  status: ContextItemStatus,
  text: string,
  messageIndex: number,
  messageId?: string,
): ContextStateItem {
  return {
    kind,
    status,
    text: text.replace(/\s+/g, ' ').trim().slice(0, ITEM_CHARS),
    messageIndex,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

export function textOf(message: AgentMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 2 && sentence.length < 2_000)
    .slice(0, 40);
}

function firstSentence(text: string): string {
  const [first] = sentencesOf(text);
  return (first ?? text).slice(0, ITEM_CHARS);
}

function pathsIn(text: string): string[] {
  const found = text.match(PATH_PATTERN);
  if (!found) return [];
  return [...new Set(found.map((path) => path.trim()))].slice(0, 10);
}

function previewOf(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 200);
  try {
    return JSON.stringify(input ?? {}).slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Marks earlier decisions the newer sentence overrules.
 *
 * "Overrules" is approximated by subject overlap: two decisions that share two or
 * more significant words are about the same thing, and the later one wins. Crude,
 * and deliberately so — the alternative is asking a model on every turn whether one
 * sentence contradicts another, which is neither cheap nor reliable.
 */
function supersedeMatching(items: ContextStateItem[], sentence: string): void {
  const decisions = items;
  const words = new Set(significantWords(sentence));
  if (words.size === 0) return;
  for (let i = 0; i < decisions.length; i += 1) {
    const candidate = decisions[i];
    if (!candidate || candidate.status !== 'active') continue;
    const shared = significantWords(candidate.text).filter((word) => words.has(word));
    if (shared.length >= 2) decisions[i] = { ...candidate, status: 'superseded' };
  }
}

function dedupe(items: readonly ContextStateItem[]): ContextStateItem[] {
  const seen = new Set<string>();
  const out: ContextStateItem[] = [];
  for (const entry of items) {
    const key = `${entry.kind}:${entry.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Folds items recovered from an earlier summary in front of freshly derived ones.
 *
 * In front, because recovered items are by definition older, and a category that is
 * capped keeps its tail. A constraint from turn 2 that survived three compactions
 * should not be evicted by a file path noticed on turn 40 — so recovered items are
 * added first and the cap trims the newest end, which is the half still present in
 * the verbatim transcript anyway.
 */
function mergeRecovered(
  derived: readonly ContextStateItem[],
  recovered: readonly ContextStateItem[],
  kind: ContextItemKind,
  status: ContextItemStatus,
): ContextStateItem[] {
  const matching = recovered.filter((entry) => entry.kind === kind && entry.status === status);
  if (matching.length === 0) return [...derived];
  return dedupe([...matching, ...derived]);
}

/** Every item in the state, flattened. Used by the verifier and the renderer. */
export function stateItems(state: ContextState): ContextStateItem[] {
  return [
    ...(state.currentGoal ? [state.currentGoal] : []),
    ...(state.activeTask ? [state.activeTask] : []),
    ...state.constraints,
    ...state.decisions,
    ...state.pending,
    ...state.completed,
    ...state.questions,
    ...state.errors,
    ...state.files,
    ...state.artifacts,
    ...state.toolState,
    ...state.recentActions,
    ...state.facts,
  ];
}

/** A count per category, for telemetry and for the console's explanation panel. */
export function stateCounts(state: ContextState): {
  goal: boolean;
  constraints: number;
  decisions: number;
  supersededDecisions: number;
  pending: number;
  completed: number;
  questions: number;
  errors: number;
  files: number;
  artifacts: number;
  toolState: number;
} {
  return {
    goal: state.currentGoal !== undefined,
    constraints: state.constraints.length,
    decisions: state.decisions.length,
    supersededDecisions: state.supersededDecisions.length,
    pending: state.pending.length,
    completed: state.completed.length,
    questions: state.questions.length,
    errors: state.errors.length,
    files: state.files.length,
    artifacts: state.artifacts.length,
    toolState: state.toolState.length,
  };
}
