import type { AgentMessage, ToolCallBlock, ToolResultBlock } from './messages.js';
import type { Artifact } from '../artifacts/artifact-store.js';
import type { ModelUsage, StopReason } from '../models/provider.js';
import type { ContextIntelligenceReport } from '../context-intelligence/contracts.js';

/**
 * The automatic context action a turn took.
 *
 * Restated here rather than imported from the context layer so the event contract
 * has no dependency on the implementation that fills it in — a consumer of the wire
 * protocol should be able to read this file alone.
 */
export type ContextActionName =
  | 'none'
  | 'tool-result-trimming'
  | 'selective-reduction'
  | 'compaction'
  | 'reactive-compaction'
  | 'recovery';

/** How many items of each kind the context state analysis found. Counts only. */
export type ContextStateCounts = {
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
};

type EventBase = {
  protocolVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId: string;
};

export type AgentEvent = EventBase &
  (
    | {
        type: 'session.started';
        mode?: 'persistent' | 'stateless';
        storage?: 'none' | 'memory' | 'file' | 's3' | 'custom';
        resumed?: boolean;
        origin?: 'new' | 'store' | 'client_history' | 'stateless';
        historyMessageCount?: number;
      }
    | {
        type: 'session.completed';
        reason: StopReason | 'closed';
        historyMessageCount?: number;
      }
    | { type: 'turn.started'; turnId: string; turn: number }
    | {
        type: 'turn.completed';
        turnId: string;
        turn: number;
        reason: StopReason;
      }
    | { type: 'assistant.text.delta'; turnId: string; delta: string }
    /**
     * The model's own deliberation, when it emits any and the provider is
     * configured to forward it. Separate from `assistant.text.delta` because it is
     * not part of the answer: it is shown differently, and a consumer that does not
     * want it can drop one event type rather than filter prose.
     */
    | { type: 'assistant.reasoning.delta'; turnId: string; delta: string }
    /**
     * A tool call arriving argument by argument, before it is complete enough to
     * run. `index` is the correlation key: the id and name are known from the first
     * chunk of a well-behaved provider but are empty strings until they arrive.
     * `tool.requested` still marks the assembled call.
     */
    | {
        type: 'tool.input.delta';
        turnId: string;
        index: number;
        toolCallId: string;
        toolName: string;
        delta: string;
      }
    | {
        type: 'assistant.message.completed';
        turnId: string;
        message: AgentMessage;
      }
    | { type: 'tool.requested'; turnId: string; call: ToolCallBlock }
    | { type: 'tool.started'; turnId: string; call: ToolCallBlock }
    | {
        type: 'tool.progress';
        turnId: string;
        toolCallId: string;
        message: string;
        data?: Record<string, unknown>;
      }
    | {
        type: 'tool.completed';
        turnId: string;
        result: ToolResultBlock;
      }
    | {
        /** A model-selected response file that a client should present to the user. */
        type: 'artifact.created';
        turnId: string;
        toolCallId: string;
        artifact: Artifact;
      }
    | {
        type: 'permission.requested';
        turnId: string;
        requestId: string;
        toolCallId: string;
        toolName: string;
        input: unknown;
        description: string;
      }
    | {
        type: 'permission.resolved';
        turnId: string;
        requestId: string;
        decision: 'allow' | 'deny';
      }
    | {
        type: 'context.compaction.started';
        turnId: string;
        estimatedTokens: number;
      }
    | {
        type: 'context.compaction.completed';
        turnId: string;
        tokensBefore: number;
        tokensAfter: number;
      }
    /**
     * Older material was left out of this request rather than summarised.
     *
     * The cheap relief that runs before compaction: redundant tool output, a
     * superseded plan, an exchange nothing since has referred to. Emitted only when
     * something was actually dropped or shortened, so an idle turn is silent.
     */
    | {
        type: 'context.selection';
        turnId: string;
        /** Messages carried into the request. */
        kept: number;
        /** Messages left out. */
        dropped: number;
        /** Tool results shortened in place. */
        trimmedToolResults: number;
        /** Tool results replaced by a pointer to an identical later result. */
        deduplicatedToolResults: number;
        /** Which history tiers gave way. */
        compressed: readonly string[];
      }
    /**
     * The prepared context was checked against the state derived from the canonical
     * history, before it was sent.
     *
     * Emitted on every turn the layer acted, passing or failing, because "we checked
     * and it was fine" is the claim that makes the rest of the layer trustworthy.
     */
    | {
        type: 'context.verification';
        turnId: string;
        passed: boolean;
        /** State categories confirmed present. */
        preserved: readonly string[];
        /** Machine-readable names of what could not be confirmed. */
        issues?: readonly string[];
      }
    /**
     * Verification found something critical missing and it was put back.
     *
     * The one event in this family that reports a correction rather than a decision.
     * A caller seeing these regularly is looking at a summariser or a selection
     * heuristic that needs attention.
     */
    | {
        type: 'context.recovery';
        turnId: string;
        /** What was restored, by category. */
        restored: readonly string[];
        /** What triggered the recovery. */
        issues: readonly string[];
        tokensBefore: number;
        tokensAfter: number;
      }
    /**
     * How full the model's context is, as the context layer measured it for this
     * turn. Emitted every turn rather than only when compaction happens, because a
     * caller showing a usage meter needs the number that did *not* trigger
     * compaction just as much as the one that did.
     *
     * `budgetTokens` is the effective input budget — the window minus the reserved
     * reply and the safety margin — so `usedPercent` is the fraction of what this
     * turn was actually allowed to spend, not of the raw window.
     */
    | {
        type: 'context.usage';
        turnId: string;
        /** Estimated input tokens the prepared context occupies. */
        usedTokens: number;
        /** Effective input budget the context was prepared against. */
        budgetTokens: number;
        /** The model's total context window, when capabilities were supplied. */
        contextWindow?: number;
        /** Tokens reserved for the reply. */
        reservedOutputTokens?: number;
        /** `usedTokens / budgetTokens` as a percentage, 0–100+, one decimal. */
        usedPercent: number;
        /** Whether this turn's context was compacted to reach that number. */
        compacted: boolean;
        /**
         * What the context measured before the layer acted on it, when it acted.
         *
         * `usedTokens` is what the request actually costs, which is the number a
         * budget cares about — but on a turn that compacted it is not the number
         * that *caused* the compaction. A meter with only the post number can never
         * show the peak it was built to warn about: it reads 96%, compaction lands,
         * and the history says 22% with nothing to explain the gap.
         */
        peakTokens?: number;
        /** `peakTokens / budgetTokens` as a percentage, one decimal. */
        peakPercent?: number;
        /** Which of the policy's thresholds the pre-action measurement crossed. */
        pressure?: 'nominal' | 'warning' | 'aggressive' | 'critical';
        /** How many oversized tool results were shortened in place this turn. */
        toolResultsTruncated?: number;
        /** Which turn of the run this measurement belongs to, for a timeline. */
        turn?: number;
        /**
         * The most expensive thing the context layer had to do this turn.
         *
         * Ordered, cheapest first, so `compaction` implies trimming and selection were
         * tried first and were not enough. Present only when an orchestrating context
         * manager prepared the turn; a bare manager reports no action, which is
         * distinguishable from reporting `'none'`.
         */
        action?: ContextActionName;
        /** How the surviving context was produced. */
        strategy?: 'passthrough' | 'deterministic' | 'llm-summarization';
        /** Whether a summarisation model was configured but not used. */
        fallbackUsed?: boolean;
        /** The post-decision check on the prepared context. */
        verification?: 'passed' | 'recovered' | 'failed';
        /** State categories the verifier confirmed are still represented. */
        preserved?: readonly string[];
        /** History tiers that lost material this turn. */
        compressed?: readonly string[];
        /** Messages in the prepared context. */
        selectedMessageCount?: number;
        /** Messages that a summary or a state block now stands in for. */
        compactedMessageCount?: number;
        /** Tool results replaced by a pointer to an identical later result. */
        deduplicatedToolResults?: number;
        /**
         * How many items of each kind the state analysis found.
         *
         * Counts only. A client showing "3 constraints, 2 open errors" needs the
         * shape of the context, and shipping the constraints themselves through
         * telemetry would put conversation content somewhere it does not belong.
         */
        state?: ContextStateCounts;
      }
    /**
     * Context Intelligence aggregate decisions plus authoritative runtime trace.
     * Trace content is produced by AgentCore at the execution boundary; clients
     * display it verbatim and must not infer execution from planning fields.
     */
    | {
        type: 'context.intelligence';
        turnId: string;
        report: ContextIntelligenceReport;
      }
    | { type: 'usage.updated'; turnId: string; usage: ModelUsage }
    /**
     * Work done before the first turn can start: the workspace, the model, MCP
     * connections, skill documents. Without these a stream is silent for as long as
     * preparation takes, which for a stdio MCP server that has to be installed is
     * the longest silence in the run.
     */
    | {
        type: 'run.preparing';
        stage: 'workspace' | 'agent' | 'mcp' | 'skills' | 'ready';
        message: string;
        data?: Record<string, unknown>;
      }
    | {
        type: 'warning';
        code: string;
        message: string;
        intervention?: import('../context-intelligence/contracts.js').ContextIntelligenceIntervention;
      }
    | { type: 'error'; code: string; message: string; recoverable: boolean }
  );

export type RunPreparationStage = Extract<AgentEvent, { type: 'run.preparing' }>['stage'];

/**
 * How the layers that run before the session report what they are doing.
 *
 * A plain callback rather than a generator because preparation is a call tree,
 * not a stream: the registry connecting an MCP server is several frames below the
 * transport that wants to say so.
 */
export type RunProgressReporter = (
  stage: RunPreparationStage,
  message: string,
  data?: Record<string, unknown>,
) => void;

export type EventPayload = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof EventBase>
    : never
  : never;

export function isSerializableEvent(event: AgentEvent): boolean {
  try {
    const serialized = JSON.stringify(event);
    return JSON.stringify(JSON.parse(serialized)) === serialized;
  } catch {
    return false;
  }
}
