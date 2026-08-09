/**
 * Folds a harness `AgentEvent` stream into the session→trace→span data model
 * from docs/observability-platform-plan.md §2 and §4: one span per turn's
 * generation (model call), one span per tool call, tool spans parented to the
 * generation span of the same turn.
 *
 * "Turn" is deliberately not a stored entity — a turn is just a generation span
 * plus whatever tool spans share it as `parentId`.
 *
 * The harness never emits what was actually sent to the model, only what it
 * said back (see the plan doc §3, gap 2), so a generation span's `input` is
 * reconstructed from what's already known — the original prompt plus every
 * prior turn's own output and tool results — rather than being the literal
 * request. That is an approximation, not ground truth.
 */
export class TraceBuilder {
  #spans = new Map();
  #order = [];
  #reasoningParts = new Map();
  #textParts = new Map();
  #toolCallSpanId = new Map();
  #transcript = [];

  constructor({ prompt } = {}) {
    if (prompt) this.#transcript.push("User:\n" + prompt);
  }

  observe(event) {
    if (typeof event?.type !== "string") return;
    switch (event.type) {
      case "turn.started":
        this.#ensureGeneration(event.turnId, event.timestamp);
        break;
      case "assistant.reasoning.delta":
        this.#append(this.#reasoningParts, event.turnId, event.timestamp, event.delta);
        break;
      case "assistant.text.delta":
        this.#append(this.#textParts, event.turnId, event.timestamp, event.delta);
        break;
      case "usage.updated":
        this.#applyUsage(event);
        break;
      case "turn.completed":
        this.#closeGeneration(event);
        break;
      case "tool.requested":
        this.#openTool(event);
        break;
      case "tool.completed":
        this.#closeTool(event);
        break;
      default:
        break;
    }
  }

  /** The finished spans, in the order their generation/tool call started. */
  spans() {
    return this.#order.map((id) => this.#spans.get(id));
  }

  #ensureGeneration(turnId, timestamp) {
    const id = "gen:" + turnId;
    if (!this.#spans.has(id)) {
      this.#spans.set(id, {
        id,
        parentId: null,
        type: "generation",
        name: "Model call",
        startedAt: timestamp,
        endedAt: null,
        status: "success",
        input: this.#transcript.join("\n\n"),
        output: "",
        usage: null,
        cost: null,
      });
      this.#order.push(id);
    }
    return id;
  }

  #append(store, turnId, timestamp, delta) {
    const id = this.#ensureGeneration(turnId, timestamp);
    const parts = store.get(id) ?? [];
    parts.push(delta ?? "");
    store.set(id, parts);
  }

  #applyUsage(event) {
    const id = this.#ensureGeneration(event.turnId, event.timestamp);
    const span = this.#spans.get(id);
    span.usage = { ...event.usage };
    if (typeof event.usage?.estimatedCostUsd === "number") {
      span.cost = { amount: event.usage.estimatedCostUsd, currency: "USD" };
    }
  }

  #closeGeneration(event) {
    const id = this.#ensureGeneration(event.turnId, event.timestamp);
    const span = this.#spans.get(id);
    span.endedAt = event.timestamp;
    span.output = (this.#textParts.get(id) ?? []).join("");
    const reasoning = (this.#reasoningParts.get(id) ?? []).join("");
    if (reasoning) span.reasoning = reasoning;
    this.#transcript.push("Assistant:\n" + (span.output || "(tool calls only)"));
  }

  #openTool(event) {
    const parentId = this.#ensureGeneration(event.turnId, event.timestamp);
    const id = "tool:" + event.call.id;
    this.#spans.set(id, {
      id,
      parentId,
      type: "tool",
      name: event.call.name,
      startedAt: event.timestamp,
      endedAt: null,
      status: "success",
      input: safeJson(event.call.input),
      output: "",
      usage: null,
      cost: null,
    });
    this.#order.push(id);
    this.#toolCallSpanId.set(event.call.id, id);
  }

  #closeTool(event) {
    const id = this.#toolCallSpanId.get(event.result.toolCallId);
    if (!id) return;
    const span = this.#spans.get(id);
    span.endedAt = event.timestamp;
    span.output = event.result.content ?? "";
    span.status = event.result.isError ? "error" : "success";
    this.#transcript.push(
      "Tool " + span.name + " " + (span.status === "error" ? "failed" : "returned") +
        ":\n" + span.output,
    );
  }
}

/** Replays a stored `events[]` array through a fresh builder in one call. */
export function buildSpans(events, context) {
  const builder = new TraceBuilder(context);
  for (const event of events ?? []) builder.observe(event);
  return builder.spans();
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
