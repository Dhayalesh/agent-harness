/**
 * Folds a harness event stream into the result the buffered path returns.
 *
 * The runtime computes this itself when it answers with JSON. Streaming asks it
 * not to, so the same arithmetic has to happen here — and it has to land on the
 * same shape, because both paths write the same run row through
 * `applyRuntimeResult`. A second shape would mean a run's fields depended on how
 * it happened to be invoked.
 */
import { presentedArtifact } from "./response-artifacts.js";
import { presentedReasoning } from "./response-reasoning.js";
import { presentedToolCall } from "./response-tool-calls.js";
import {
  contextIntelligenceInterventionSchema,
  contextIntelligenceReportSchema,
} from "../lib/schemas.js";

/**
 * How many turns of context history a run keeps.
 *
 * Bounded and tail-kept, matching the runtime's own limit. A 200-turn run does not
 * need 200 rows in a chat document to explain itself, and an unbounded array on a
 * hot record is how a document hits its size limit in production rather than in a
 * test.
 */
const CONTEXT_TIMELINE_LIMIT = 40;

export class RunTotals {
  #text = [];
  #reasoning = [];
  #messageText = [];
  #messageReasoning = [];
  #tools = new Map();
  #toolNamesByCallId = new Map();
  #usage = { inputTokens: 0, outputTokens: 0 };
  #turns = 0;
  #stopReason;
  #failure;
  #sessionId;
  #session;
  #toolInputs = new Map();
  #toolActivity = new Map();
  #artifacts = [];
  #context;
  #contextIntelligence;
  #intervention;
  #compactions = 0;
  #recoveries = 0;
  #peakTokens;
  #peakPercent = 0;
  #timeline = [];

  observe(event) {
    if (typeof event?.type !== "string") return;
    if (typeof event.sessionId === "string") this.#sessionId = event.sessionId;

    switch (event.type) {
      case "assistant.text.delta":
        this.#text.push(event.delta ?? "");
        this.#messageText.push(event.delta ?? "");
        break;
      case "tool.input.delta": {
        const key = event.toolCallId || `index-${event.index}`;
        const input = (this.#toolInputs.get(key) ?? "") + (event.delta ?? "");
        this.#toolInputs.set(key, input);
        this.#updateActivity(key, {
          name: event.toolName,
          input,
          status: "pending",
        });
        break;
      }
      case "session.started":
        this.#session = {
          mode: event.mode ?? "persistent",
          storage: event.storage ?? "custom",
          resumed: event.resumed === true,
          origin: event.origin ?? "new",
          historyMessageCount: event.historyMessageCount ?? 0,
        };
        break;
      case "assistant.reasoning.delta":
        this.#reasoning.push(event.delta ?? "");
        this.#messageReasoning.push(event.delta ?? "");
        break;
      case "assistant.message.completed":
        this.#completeAssistantMessage(event.message);
        break;
      case "turn.completed":
        this.#turns = Math.max(this.#turns, event.turn ?? 0);
        this.#stopReason = event.reason;
        break;
      case "session.completed":
        this.#stopReason = event.reason;
        if (this.#session && typeof event.historyMessageCount === "number") {
          this.#session.historyMessageCount = event.historyMessageCount;
        }
        break;
      // Counted on `requested` rather than `started`, because a call the
      // permission handler denied never starts but does produce a result.
      case "tool.requested":
        this.#countCall(event.call);
        if (event.call?.id) {
          this.#toolInputs.set(event.call.id, event.call.input);
          this.#updateActivity(event.call.id, {
            name: event.call.name,
            input: event.call.input,
            status: "pending",
          });
        }
        break;
      case "tool.started":
        if (event.call?.id) {
          this.#updateActivity(event.call.id, {
            name: event.call.name,
            input: event.call.input,
            status: "running",
          });
        }
        break;
      case "tool.progress":
        if (event.toolCallId) {
          const existing = this.#toolActivity.get(event.toolCallId);
          this.#updateActivity(event.toolCallId, {
            output: [...(existing?.output ?? []), event.message].slice(-40),
            status: "running",
          });
        }
        break;
      case "tool.completed":
        this.#countResult(event.result);
        if (event.result?.toolCallId) {
          this.#updateActivity(event.result.toolCallId, {
            output: event.result.content,
            status: event.result.isError ? "error" : "done",
          });
        }
        break;
      case "artifact.created": {
        const artifact = presentedArtifact(
          event.artifact,
          this.#toolInputs.get(event.toolCallId),
          this.#toolNamesByCallId.get(event.toolCallId),
        );
        if (artifact) this.#artifacts.push(artifact);
        break;
      }
      case "usage.updated":
        this.#addUsage(event.usage);
        break;
      // Last one wins: the meter shows where the context stands now, which is
      // what the most recent turn measured.
      case "context.usage": {
        // Except the peak, which is a high water mark. A run that compacted mid-way
        // ends on a low reading, and the stored record needs the number that caused
        // the compaction as well as the one that followed it.
        const candidate = event.peakTokens ?? event.usedTokens ?? 0;
        if (this.#peakTokens === undefined || candidate > this.#peakTokens) {
          this.#peakTokens = candidate;
          this.#peakPercent = event.peakPercent ?? event.usedPercent ?? 0;
        }
        // One entry per measured turn, so a reopened chat can show what happened and
        // when rather than only where things ended up. The interesting turn is by
        // definition not the last one: the meter reads 32% precisely because turn 25
        // was at 91% and something was done about it.
        if (
          typeof event.turn === "number" ||
          typeof event.action === "string"
        ) {
          this.#timeline.push({
            ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
            usedPercent: event.usedPercent ?? 0,
            ...(typeof event.action === "string" ? { action: event.action } : {}),
            ...(event.compacted === true ? { compacted: true } : {}),
          });
          if (this.#timeline.length > CONTEXT_TIMELINE_LIMIT) {
            this.#timeline.shift();
          }
        }
        this.#context = {
          usedTokens: event.usedTokens ?? 0,
          budgetTokens: event.budgetTokens ?? 0,
          ...(typeof event.contextWindow === "number"
            ? { contextWindow: event.contextWindow }
            : {}),
          ...(typeof event.reservedOutputTokens === "number"
            ? { reservedOutputTokens: event.reservedOutputTokens }
            : {}),
          usedPercent: event.usedPercent ?? 0,
          compacted: this.#compactions > 0 || event.compacted === true,
          ...(this.#peakTokens === undefined
            ? {}
            : { peakTokens: this.#peakTokens, peakPercent: this.#peakPercent }),
          // Everything below is present only when the runtime's orchestration layer
          // reported it. A runtime built before it, or one running a custom context
          // manager, stores exactly the shape it always did.
          ...(typeof event.pressure === "string"
            ? { pressure: event.pressure }
            : {}),
          ...(typeof event.action === "string" ? { action: event.action } : {}),
          ...(typeof event.strategy === "string"
            ? { strategy: event.strategy }
            : {}),
          ...(typeof event.verification === "string"
            ? { verification: event.verification }
            : {}),
          ...(Array.isArray(event.preserved)
            ? { preserved: event.preserved }
            : {}),
          ...(Array.isArray(event.compressed)
            ? { compressed: event.compressed }
            : {}),
          ...(event.state && typeof event.state === "object"
            ? { state: event.state }
            : {}),
          ...(this.#timeline.length === 0
            ? {}
            : { timeline: [...this.#timeline] }),
          ...(this.#recoveries === 0 ? {} : { recoveries: this.#recoveries }),
        };
        break;
      }
      case "context.compaction.completed":
        this.#compactions += 1;
        break;
      case "context.intelligence":
        {
          const parsed = contextIntelligenceReportSchema.safeParse(
            event.report,
          );
          if (!parsed.success) break;
          // Last report wins, matching the buffered Harness result: it describes
          // the final model decision or the terminal Context Intelligence outcome.
          this.#contextIntelligence = structuredClone(parsed.data);
        }
        break;
      case "warning":
        {
          const parsed = contextIntelligenceInterventionSchema.safeParse(
            event.intervention,
          );
          if (parsed.success) {
            // Warnings remain backward-compatible; only the bounded typed payload
            // becomes an application outcome on the folded result.
            this.#intervention = structuredClone(parsed.data);
          }
        }
        break;
      // Counted, not stored in detail: what a reader needs is "the layer had to put
      // something back", and the harness log already holds which categories.
      case "context.recovery":
        this.#recoveries += 1;
        break;
      case "error":
        this.#failure = {
          code: event.code ?? "RUNTIME_ERROR",
          message: event.message ?? "The runtime reported an error.",
          recoverable: event.recoverable === true,
        };
        break;
      default:
        break;
    }
  }

  #countCall(call) {
    if (!call?.name) return;
    const summary = this.#tools.get(call.name) ?? {
      name: call.name,
      calls: 0,
      errors: 0,
    };
    summary.calls += 1;
    this.#tools.set(call.name, summary);
    if (call.id) this.#toolNamesByCallId.set(call.id, call.name);
  }

  #countResult(result) {
    if (!result?.isError) return;
    const name = this.#toolNamesByCallId.get(result.toolCallId);
    const summary = this.#tools.get(name);
    if (summary) summary.errors += 1;
  }

  #addUsage(usage) {
    if (!usage) return;
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "estimatedCostUsd",
    ]) {
      if (typeof usage[field] !== "number") continue;
      this.#usage[field] = (this.#usage[field] ?? 0) + usage[field];
    }
  }

  #completeAssistantMessage(message) {
    const text = (message?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    appendMissingSuffix(this.#text, this.#messageText.join(""), text);
    appendMissingSuffix(
      this.#reasoning,
      this.#messageReasoning.join(""),
      message?.reasoning ?? "",
    );
    this.#messageText = [];
    this.#messageReasoning = [];
  }

  #updateActivity(id, patch) {
    const current = this.#toolActivity.get(id) ?? {
      id,
      name: "tool",
      input: "",
      output: [],
      status: "pending",
    };
    this.#toolActivity.set(id, {
      ...current,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    });
  }

  /** The assistant's answer so far. Used for the persisted chat message. */
  get output() {
    return this.#text.join("");
  }

  get reasoning() {
    return this.#reasoning.join("");
  }

  /**
   * A stream that ended without `session.completed` was cut off, so it is a
   * failure even though no `error` event named one.
   */
  result({ agentName, durationMs, runtimeSessionId }) {
    const failure =
      this.#failure ??
      (this.#stopReason === undefined
        ? {
            code: "RUNTIME_STREAM_INCOMPLETE",
            message: "The runtime stream ended before the turn completed.",
            recoverable: true,
          }
        : undefined);

    const artifacts = [...this.#artifacts];
    const output = this.output;
    return {
      status: failure ? "error" : "success",
      sessionId: this.#sessionId ?? runtimeSessionId,
      agentName,
      session: this.#session ?? {
        mode: "persistent",
        storage: "custom",
        resumed: false,
        origin: "new",
        historyMessageCount: 0,
      },
      output,
      response: artifacts.length
        ? { type: "files", files: artifacts }
        : { type: "text", text: output },
      artifacts,
      toolCalls: [...this.#toolActivity.values()].map(presentedToolCall),
      ...(this.reasoning
        ? { reasoning: presentedReasoning(this.reasoning) }
        : {}),
      messages: [],
      workingDirectory: "",
      ...(this.#stopReason === undefined
        ? {}
        : { stopReason: this.#stopReason }),
      turns: this.#turns,
      usage: this.#usage,
      tools: [...this.#tools.values()],
      ...(this.#context
        ? { context: { ...this.#context, compactions: this.#compactions } }
        : {}),
      ...(this.#contextIntelligence
        ? { contextIntelligence: this.#contextIntelligence }
        : {}),
      ...(this.#intervention ? { intervention: this.#intervention } : {}),
      durationMs,
      ...(failure ? { error: failure } : {}),
    };
  }
}

function appendMissingSuffix(target, streamed, completed) {
  if (!completed || completed === streamed) return;
  if (!streamed) {
    target.push(completed);
    return;
  }
  if (completed.startsWith(streamed)) {
    target.push(completed.slice(streamed.length));
  }
}
