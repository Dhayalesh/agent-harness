import { randomUUID } from "node:crypto";
import { Run } from "../models/run.js";
import {
  invokeAgentRuntime,
  openAgentRuntimeStream,
  resolveRuntime,
} from "./agentcore.js";
import { buildPayload } from "./payload.js";
import { nowIso } from "./platform.js";
import { RunTotals } from "./run-totals.js";
import {
  artifactMetadata,
  hydrateRuntimeArtifacts,
} from "./response-artifacts.js";
import { hydrateRuntimeReasoning } from "./response-reasoning.js";
import { hydrateRuntimeText } from "./response-text.js";
import { hydrateRuntimeToolCalls } from "./response-tool-calls.js";

export async function invokeStoredAgent({
  agentId,
  prompt,
  attachments = [],
  runtimeSessionId = randomUUID(),
  permissionMode,
  includeEvents = false,
  chatId,
  sessionHistory = [],
  compactContext = false,
  operation = "turn",
}) {
  const { payload, resolved } = await buildPayload({
    agentId,
    prompt,
    attachments,
    sessionId: runtimeSessionId,
    permissionMode,
    includeEvents,
    sessionHistory,
    compactContext,
    operation,
  });
  const runtime = resolveRuntime(resolved.agent.value);
  const run = await startRun({
    resolved,
    runtime,
    runtimeSessionId,
    prompt:
      operation === "compact"
        ? "(context compaction)"
        : runPrompt(prompt, attachments),
    chatId,
  });

  let invocation;
  try {
    invocation = await invokeAgentRuntime({
      runtime,
      payload,
      runtimeSessionId,
    });
    invocation.result = hydrateRuntimeText(
      hydrateRuntimeReasoning(
        hydrateRuntimeToolCalls(hydrateRuntimeArtifacts(invocation.result)),
      ),
    );
  } catch (error) {
    await failRun(run, error);
    throw error;
  }

  applyRuntimeResult(run, invocation.result, invocation);
  await run.save();

  return {
    run,
    events: invocation.result.events,
    result: invocation.result,
    runtime,
    payload,
    resolved,
  };
}

/**
 * The same invocation, read as it happens.
 *
 * Returns what `invokeStoredAgent` returns, so a caller that only wants the
 * finished run can ignore `onEvent` and treat the two identically. The result is
 * folded from the events rather than returned by the runtime, because a streaming
 * runtime never sends one; see `RunTotals`.
 *
 * `onEvent` is awaited. A caller writing to a socket needs backpressure honoured,
 * and awaiting here is what stops a fast run from queueing its whole transcript
 * in this process's memory.
 */
export async function streamStoredAgent({
  agentId,
  prompt,
  attachments = [],
  runtimeSessionId = randomUUID(),
  permissionMode,
  includeEvents = false,
  chatId,
  onEvent,
  signal,
  sessionHistory = [],
  compactContext = false,
}) {
  const { payload, resolved } = await buildPayload({
    agentId,
    prompt,
    attachments,
    sessionId: runtimeSessionId,
    permissionMode,
    includeEvents,
    sessionHistory,
    compactContext,
  });
  const runtime = resolveRuntime(resolved.agent.value);
  const run = await startRun({
    resolved,
    runtime,
    runtimeSessionId,
    prompt: runPrompt(prompt, attachments),
    chatId,
  });
  const started = Date.now();

  let stream;
  try {
    stream = await openAgentRuntimeStream({
      runtime,
      payload,
      runtimeSessionId,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    await failRun(run, error);
    throw error;
  }

  const totals = new RunTotals();
  const collected = [];
  try {
    for await (const event of stream.events) {
      totals.observe(event);
      if (includeEvents) collected.push(event);
      if (onEvent) await onEvent(event);
    }
  } catch (error) {
    // Whatever arrived before the stream broke is still worth keeping: the run
    // spent those tokens, and the partial answer is what the caller already saw.
    const result = totals.result({
      agentName: resolved.agent.value.name,
      durationMs: Date.now() - started,
      runtimeSessionId,
    });
    result.status = "error";
    result.error = {
      code: "RUNTIME_STREAM_FAILED",
      message: error.message,
      recoverable: error.status === 429 || error.status === 409,
    };
    applyRuntimeResult(run, result, stream);
    await run.save();
    throw error;
  }

  const result = totals.result({
    agentName: resolved.agent.value.name,
    durationMs: Date.now() - started,
    runtimeSessionId,
  });
  applyRuntimeResult(run, result, stream);
  await run.save();

  return {
    run,
    events: includeEvents ? collected : undefined,
    result,
    runtime,
    payload,
    resolved,
  };
}

/**
 * What the run record shows as the request.
 *
 * A files-only turn has no words, and a run listed with an empty prompt tells a
 * reader nothing about what it did. The names stand in for the message; the model
 * still receives the real prompt, which the harness composes from the attachments.
 */
function runPrompt(prompt, attachments) {
  const text = String(prompt ?? "").trim();
  if (text) return text;
  if (!attachments.length) return "(no prompt)";
  return `(${attachments.length} file${attachments.length === 1 ? "" : "s"}: ${attachments
    .map((attachment) => attachment.filename)
    .join(", ")})`;
}

function startRun({ resolved, runtime, runtimeSessionId, prompt, chatId }) {
  const timestamp = nowIso();
  return Run.create({
    agentId: resolved.agent.document._id.toString(),
    agentName: resolved.agent.value.name,
    ...(chatId ? { chatId } : {}),
    prompt,
    status: "running",
    agentRuntimeArn: runtime.arn,
    agentRuntimeQualifier: runtime.qualifier ?? "DEFAULT",
    runtimeSessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function failRun(run, error) {
  run.status = "error";
  run.error = {
    code: "AGENTCORE_INVOCATION_FAILED",
    message: error.message,
    recoverable: error.status === 429 || error.status === 409,
  };
  run.updatedAt = nowIso();
  await run.save();
}

/**
 * One place both paths write their outcome, so a run's stored fields do not
 * depend on which transport produced it.
 */
function applyRuntimeResult(run, result, invocation) {
  run.status = result.status;
  run.output = result.output ?? "";
  run.stopReason = result.stopReason;
  run.turns = result.turns ?? 0;
  run.usage = {
    ...(result.usage ?? {}),
    totalTokens:
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
  };
  // Left unset rather than zeroed when the runtime reported none, so "no context
  // layer" stays distinguishable from "an empty context".
  if (result.context) run.context = result.context;
  if (result.contextIntelligence) {
    run.contextIntelligence = result.contextIntelligence;
  }
  run.tools = result.tools ?? [];
  run.artifacts = artifactMetadata(result.artifacts);
  run.harnessSessionId = result.sessionId;
  run.session = result.session;
  run.workingDirectory = result.workingDirectory;
  run.durationMs = result.durationMs;
  run.runtimeSessionId = invocation.runtimeSessionId;
  run.traceId = invocation.traceId;
  if (result.error) run.error = result.error;
  run.updatedAt = nowIso();
}
