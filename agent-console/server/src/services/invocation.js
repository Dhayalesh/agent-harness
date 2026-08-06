import { randomUUID } from "node:crypto";
import { Run } from "../models/run.js";
import { invokeAgentRuntime, resolveRuntime } from "./agentcore.js";
import { buildPayload } from "./payload.js";
import { nowIso } from "./platform.js";

export async function invokeStoredAgent({
  agentId,
  prompt,
  runtimeSessionId = randomUUID(),
  permissionMode,
  includeEvents = false,
  chatId,
}) {
  const { payload, resolved } = await buildPayload({
    agentId,
    prompt,
    sessionId: runtimeSessionId,
    permissionMode,
    includeEvents,
  });
  const runtime = resolveRuntime(resolved.agent.value);
  const timestamp = nowIso();
  const run = await Run.create({
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

  let invocation;
  try {
    invocation = await invokeAgentRuntime({
      runtime,
      payload,
      runtimeSessionId,
    });
  } catch (error) {
    run.status = "error";
    run.error = {
      code: "AGENTCORE_INVOCATION_FAILED",
      message: error.message,
      recoverable: error.status === 429 || error.status === 409,
    };
    run.updatedAt = nowIso();
    await run.save();
    throw error;
  }

  const result = invocation.result;
  run.status = result.status;
  run.output = result.output ?? "";
  run.stopReason = result.stopReason;
  run.turns = result.turns ?? 0;
  run.usage = {
    ...(result.usage ?? {}),
    totalTokens:
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
  };
  run.tools = result.tools ?? [];
  run.harnessSessionId = result.sessionId;
  run.workingDirectory = result.workingDirectory;
  run.durationMs = result.durationMs;
  run.runtimeSessionId = invocation.runtimeSessionId;
  run.traceId = invocation.traceId;
  if (result.error) run.error = result.error;
  run.updatedAt = nowIso();
  await run.save();

  return {
    run,
    events: result.events,
    result,
    runtime,
    payload,
    resolved,
  };
}
