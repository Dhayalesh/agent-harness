/**
 * Folds a harness event stream into the result the buffered path returns.
 *
 * The runtime computes this itself when it answers with JSON. Streaming asks it
 * not to, so the same arithmetic has to happen here — and it has to land on the
 * same shape, because both paths write the same run row through
 * `applyRuntimeResult`. A second shape would mean a run's fields depended on how
 * it happened to be invoked.
 */
export class RunTotals {
  #text = [];
  #reasoning = [];
  #tools = new Map();
  #toolNamesByCallId = new Map();
  #usage = { inputTokens: 0, outputTokens: 0 };
  #turns = 0;
  #stopReason;
  #failure;
  #sessionId;

  observe(event) {
    if (typeof event?.type !== "string") return;
    if (typeof event.sessionId === "string") this.#sessionId = event.sessionId;

    switch (event.type) {
      case "assistant.text.delta":
        this.#text.push(event.delta ?? "");
        break;
      case "assistant.reasoning.delta":
        this.#reasoning.push(event.delta ?? "");
        break;
      case "turn.completed":
        this.#turns = Math.max(this.#turns, event.turn ?? 0);
        this.#stopReason = event.reason;
        break;
      case "session.completed":
        this.#stopReason = event.reason;
        break;
      // Counted on `requested` rather than `started`, because a call the
      // permission handler denied never starts but does produce a result.
      case "tool.requested":
        this.#countCall(event.call);
        break;
      case "tool.completed":
        this.#countResult(event.result);
        break;
      case "usage.updated":
        this.#addUsage(event.usage);
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

    return {
      status: failure ? "error" : "success",
      sessionId: this.#sessionId ?? runtimeSessionId,
      agentName,
      output: this.output,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      messages: [],
      workingDirectory: "",
      ...(this.#stopReason === undefined ? {} : { stopReason: this.#stopReason }),
      turns: this.#turns,
      usage: this.#usage,
      tools: [...this.#tools.values()],
      durationMs,
      ...(failure ? { error: failure } : {}),
    };
  }
}
