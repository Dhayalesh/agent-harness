import { resolveAgentForInvocation } from "./platform.js";

export async function buildPayload({
  agentId,
  prompt,
  attachments = [],
  sessionId,
  permissionMode,
  includeEvents,
  sessionHistory = [],
  compactContext = false,
  operation = "turn",
}) {
  const resolved = await resolveAgentForInvocation(agentId);
  const agent = resolved.agent.value;
  const provider = resolved.modelProvider.value;

  const permissionRules = agent.tools.map((tool) => ({
    tool,
    decision: "allow",
  }));
  if (resolved.mcpServers.length) {
    permissionRules.push({ tool: "mcp__*", decision: "allow" });
  }
  if (resolved.skills.length) {
    permissionRules.push({ tool: "skill", decision: "allow" });
  }

  const payload = {
    prompt,
    // Omitted for normal turns so existing clients and payload snapshots retain the
    // original strict contract. The explicit value marks a control-plane request.
    ...(operation === "compact" ? { operation: "compact" } : {}),
    // Same rule as `stream` below: the runtime payload schema is strict, so a turn
    // with no files keeps sending the payload a runtime built before attachments
    // existed still accepts.
    ...(attachments.length ? { attachments } : {}),
    agent: compact({
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      tools: [...agent.tools],
      limits: { ...agent.limits },
    }),
    modelProvider: pick(provider, [
      "name",
      "provider",
      "model",
      "baseURL",
      "apiKey",
      "auth",
      "capabilities",
      "wire",
      "headers",
    ]),
    mcpServers: resolved.mcpServers.map(({ value }) =>
      pick(value, [
        "name",
        "transport",
        "command",
        "args",
        "env",
        "url",
        "apiKey",
        "auth",
        "capabilities",
        "wire",
        "headers",
      ]),
    ),
    skills: resolved.skills.map((skill) =>
      compact({
        name: skill.value.name,
        uri: skill.value.uri,
        allowedTools: skill.allowedTools,
      }),
    ),
    ...(resolved.templates.length
      ? {
          templates: resolved.templates.map((template) => ({
            name: template.value.name,
            uri: template.value.uri,
          })),
        }
      : {}),
    permissionMode: permissionMode ?? "default",
    permissionRules,
    permissionFallback: "deny",
    includeEvents: Boolean(includeEvents),
    // Only present when asked for, for the same reason as `stream` below: the
    // runtime payload schema is strict, so a console talking to a runtime built
    // before this field existed must not send it unprompted.
    ...(compactContext ? { compactContext: true } : {}),
    session: {
      mode: "persistent",
      history: sessionHistory,
    },
    // Only present when the agent asked for it. The runtime payload schema is
    // strict, so an agent that never opted in keeps sending the payload a runtime
    // built before this field still accepts.
    ...(agent.stream ? { stream: true } : {}),
    metadata: {
      source: "agent-console",
      agentId: resolved.agent.document._id.toString(),
    },
  };
  if (sessionId) payload.sessionId = sessionId;
  return { payload, resolved };
}

export function redactPayload(value) {
  return redact(value);
}

function redact(value, key = "") {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (typeof value !== "object") {
    return isSecretKey(key) ? "***redacted***" : value;
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (["env", "headers"].includes(childKey) && isObject(childValue)) {
      result[childKey] = Object.fromEntries(
        Object.keys(childValue).map((name) => [name, "***redacted***"]),
      );
    } else if (isSecretKey(childKey)) {
      result[childKey] =
        childValue === undefined || childValue === null || childValue === ""
          ? childValue
          : "***redacted***";
    } else {
      result[childKey] = redact(childValue, childKey);
    }
  }
  return result;
}

function isSecretKey(key) {
  return /(?:api[-_]?key|secret|password|token)$/i.test(key);
}

function pick(source, fields) {
  const output = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      output[field] = source[field];
    }
  }
  return output;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
