import mongoose from "mongoose";
import { AVAILABLE_TOOLS } from "../config.js";
import { badRequest, notFound } from "../lib/http-error.js";
import {
  agentRecordSchema,
  mcpServerRecordSchema,
  modelProviderRecordSchema,
  parseRecordOrThrow,
  skillRecordSchema,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { McpServer } from "../models/mcp-server.js";
import { ModelProvider } from "../models/model-provider.js";
import { Skill } from "../models/skill.js";
import { parseS3Uri } from "./skill-content.js";

export const nowIso = () => new Date().toISOString();

export function requireObjectId(value, label = "record") {
  if (!mongoose.isValidObjectId(value) || String(value).toLowerCase() !== String(value)) {
    throw notFound("No " + label + " with id " + value);
  }
  return String(value);
}

export async function loadAgent(id, { requireEnabled = false } = {}) {
  const agent = await Agent.findById(requireObjectId(id, "agent"));
  if (!agent) throw notFound("No agent with id " + id);
  if (requireEnabled && !agent.enabled) {
    throw badRequest("Agent " + agent.name + " is disabled.");
  }
  return agent;
}

export async function loadModelProvider(id, { withSecrets = false } = {}) {
  const query = ModelProvider.findById(requireObjectId(id, "model provider"));
  if (withSecrets) query.select("+apiKey +headers");
  const provider = await query;
  if (!provider) throw notFound("No model provider with id " + id);
  return provider;
}

export async function loadMcpServer(id, { withSecrets = false } = {}) {
  const query = McpServer.findById(requireObjectId(id, "MCP server"));
  if (withSecrets) query.select("+apiKey +env +headers");
  const server = await query;
  if (!server) throw notFound("No MCP server with id " + id);
  return server;
}

export async function loadSkill(id) {
  const skill = await Skill.findById(requireObjectId(id, "skill"));
  if (!skill) throw notFound("No skill with id " + id);
  return skill;
}

export function safeModelProvider(document) {
  const value = plain(document);
  const endpoint = safeEndpoint(value.baseURL);
  return {
    ...without(value, ["apiKey", "headers", "baseURL"]),
    ...(endpoint.value !== undefined ? { baseURL: endpoint.value } : {}),
    ...(endpoint.redacted ? { baseURLRedacted: true } : {}),
    id: document._id.toString(),
    hasApiKey: typeof value.apiKey === "string" && value.apiKey.length > 0,
    hasHeaders: Boolean(value.headers && Object.keys(value.headers).length),
    headerNames: Object.keys(value.headers ?? {}).sort(),
  };
}

export function safeMcpServer(document) {
  const value = plain(document);
  const endpoint = safeEndpoint(value.url);
  return {
    ...without(value, ["apiKey", "env", "headers", "url"]),
    ...(endpoint.value !== undefined ? { url: endpoint.value } : {}),
    ...(endpoint.redacted ? { urlRedacted: true } : {}),
    id: document._id.toString(),
    hasApiKey: typeof value.apiKey === "string" && value.apiKey.length > 0,
    hasEnv: Boolean(value.env && Object.keys(value.env).length),
    envKeys: Object.keys(value.env ?? {}).sort(),
    hasHeaders: Boolean(value.headers && Object.keys(value.headers).length),
    headerNames: Object.keys(value.headers ?? {}).sort(),
  };
}

export function safeSkill(document) {
  return { ...plain(document), id: document._id.toString() };
}

export function safeAgent(document, { includeSystemPrompt = false } = {}) {
  const value = plain(document);
  if (!includeSystemPrompt) delete value.systemPrompt;
  return {
    ...value,
    id: document._id.toString(),
    ...(!includeSystemPrompt ? { hasSystemPrompt: Boolean(document.systemPrompt) } : {}),
  };
}

export async function resolveAgentSummaries(
  documents,
  { includeSystemPrompt = false } = {},
) {
  const providerIds = new Set(documents.map((agent) => agent.modelProviderId));
  const mcpIds = new Set(documents.flatMap((agent) => agent.mcpServerIds ?? []));
  const skillIds = new Set(
    documents.flatMap((agent) => (agent.skills ?? []).map((entry) => entry.skillId)),
  );
  const [providers, servers, skills] = await Promise.all([
    ModelProvider.find({ _id: { $in: objectIds(providerIds) } }).select(
      "+apiKey +headers",
    ),
    McpServer.find({ _id: { $in: objectIds(mcpIds) } }).select(
      "+apiKey +env +headers",
    ),
    Skill.find({ _id: { $in: objectIds(skillIds) } }),
  ]);
  const providerMap = byId(providers);
  const serverMap = byId(servers);
  const skillMap = byId(skills);

  return documents.map((agent) =>
    resolvedSummary(agent, providerMap, serverMap, skillMap, includeSystemPrompt),
  );
}

export async function resolveAgentForInvocation(id) {
  const agent = await loadAgent(id, { requireEnabled: true });
  const storedAgent = validateDocument(agentRecordSchema, agent, "Agent");
  const provider = await loadModelProvider(storedAgent.modelProviderId, {
    withSecrets: true,
  });
  if (!provider.enabled) {
    throw badRequest("Model provider " + provider.name + " is disabled.");
  }
  const providerValue = plain(provider);
  providerValue.name = payloadIdentifier(
    providerValue.name,
    "provider-" + provider._id.toString(),
  );
  const storedProvider = parseRecordOrThrow(
    modelProviderRecordSchema,
    providerValue,
    "Model provider",
  );

  const mcpServers = [];
  for (const idValue of storedAgent.mcpServerIds) {
    const server = await loadMcpServer(idValue, { withSecrets: true });
    if (!server.enabled) throw badRequest("MCP server " + server.name + " is disabled.");
    const configurationIssue = mcpConfigurationIssue(server);
    if (configurationIssue) throw badRequest(configurationIssue.message);
    mcpServers.push({
      document: server,
      value: validateDocument(mcpServerRecordSchema, server, "MCP server"),
    });
  }

  const skills = [];
  for (const entry of storedAgent.skills) {
    const skill = await loadSkill(entry.skillId);
    if (!skill.enabled) throw badRequest("Skill " + skill.name + " is disabled.");
    const value = validateDocument(skillRecordSchema, skill, "Skill");
    parseS3Uri(value.uri, "skill " + value.name);
    skills.push({
      document: skill,
      value,
      allowedTools: entry.allowedTools,
    });
  }

  assertAgentProviderCompatibility(storedAgent, storedProvider);
  return {
    agent: { document: agent, value: storedAgent },
    modelProvider: { document: provider, value: storedProvider },
    mcpServers,
    skills,
  };
}

export async function assertAgentReferences(value) {
  const provider = await loadModelProvider(value.modelProviderId);
  assertAgentProviderCompatibility(value, provider);
  for (const id of value.mcpServerIds ?? []) await loadMcpServer(id);
  for (const entry of value.skills ?? []) await loadSkill(entry.skillId);
}

export function createRecord(Model, input) {
  const timestamp = nowIso();
  return Model.create({
    ...input,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function saveMergedRecord(document, patch, schema, label, options = {}) {
  const existing = plain(document);
  const normalized = { ...patch };
  for (const field of options.secretStrings ?? []) {
    if (normalized[field] === "") normalized[field] = existing[field];
  }
  for (const field of options.secretMaps ?? []) {
    if (normalized[field] === "") {
      normalized[field] = existing[field];
    } else if (normalized[field] && typeof normalized[field] === "object") {
      normalized[field] = mergeSecretMap(existing[field], normalized[field]);
    }
  }
  for (const [field, value] of Object.entries(normalized)) {
    if (value === null || value === "") document.set(field, undefined);
    else document.set(field, value);
  }
  document.updatedAt = nowIso();
  validateDocument(schema, document, label);
  await document.save();
  return document;
}

export function plain(document) {
  const value = document.toObject({
    depopulate: true,
    flattenMaps: true,
    transform: false,
  });
  delete value._id;
  delete value.__v;
  return value;
}

function resolvedSummary(
  agent,
  providerMap,
  serverMap,
  skillMap,
  includeSystemPrompt,
) {
  const issues = [];
  const provider = providerMap.get(agent.modelProviderId);
  if (!provider) issues.push(issueValue("MODEL_PROVIDER_MISSING", "Referenced model provider is missing."));
  else if (!provider.enabled) {
    issues.push(issueValue("MODEL_PROVIDER_DISABLED", "Referenced model provider is disabled."));
  }
  if (provider) {
    const limitIssue = agentProviderLimitIssue(agent, provider);
    if (limitIssue) issues.push(limitIssue);
    const streamingIssue = agentStreamingIssue(agent, provider);
    if (streamingIssue) issues.push(streamingIssue);
  }

  const servers = (agent.mcpServerIds ?? []).map((id) => {
    const server = serverMap.get(id);
    if (!server) {
      issues.push(issueValue("MCP_SERVER_MISSING", "A referenced MCP server is missing."));
      return { id, missing: true };
    }
    if (!server.enabled) {
      issues.push(issueValue("MCP_SERVER_DISABLED", "A referenced MCP server is disabled."));
    }
    const configurationIssue = mcpConfigurationIssue(server);
    if (configurationIssue) issues.push(configurationIssue);
    return summaryMcp(server);
  });

  const resolvedSkills = (agent.skills ?? []).map((entry) => {
    const skill = skillMap.get(entry.skillId);
    if (!skill) {
      issues.push(issueValue("SKILL_MISSING", "A referenced skill is missing."));
      return { id: entry.skillId, missing: true, allowedTools: entry.allowedTools };
    }
    if (!skill.enabled) {
      issues.push(issueValue("SKILL_DISABLED", "A referenced skill is disabled."));
    }
    return { ...summarySkill(skill), allowedTools: entry.allowedTools };
  });

  const unavailable = (agent.tools ?? []).filter(
    (tool) => !AVAILABLE_TOOLS.includes(tool),
  );
  if (unavailable.length) {
    issues.push(
      issueValue(
        "TOOLS_UNAVAILABLE",
        "Deployment does not advertise: " + unavailable.join(", "),
      ),
    );
  }
  if (!agent.enabled) issues.push(issueValue("AGENT_DISABLED", "Agent is disabled."));

  return {
    ...safeAgent(agent, { includeSystemPrompt }),
    resolved: {
      ready: issues.length === 0,
      issues,
      modelProvider: provider ? summaryProvider(provider) : null,
      mcpServers: servers,
      skills: resolvedSkills,
    },
  };
}

function summaryProvider(document) {
  const safe = safeModelProvider(document);
  return {
    id: safe.id,
    name: safe.name,
    provider: safe.provider,
    model: safe.model,
    enabled: safe.enabled,
    hasApiKey: safe.hasApiKey,
  };
}

function summaryMcp(document) {
  const safe = safeMcpServer(document);
  return {
    id: safe.id,
    name: safe.name,
    transport: safe.transport,
    enabled: safe.enabled,
    hasApiKey: safe.hasApiKey,
    hasEnv: safe.hasEnv,
  };
}

function summarySkill(document) {
  const safe = safeSkill(document);
  return { id: safe.id, name: safe.name, uri: safe.uri, enabled: safe.enabled };
}

function validateDocument(schema, document, label) {
  return parseRecordOrThrow(schema, plain(document), label);
}

function assertAgentProviderCompatibility(agent, provider) {
  const issue =
    agentProviderLimitIssue(agent, provider) ??
    agentStreamingIssue(agent, provider);
  if (issue) throw badRequest(issue.message);
}

/**
 * A streaming agent needs a provider that streams. The capability is stored on the
 * provider record, so this catches the mismatch at save time rather than leaving it
 * for the runtime to reject mid-turn.
 */
export function agentStreamingIssue(agent, provider) {
  if (!agent.stream) return null;
  if (provider.capabilities?.supportsStreaming === false) {
    return issueValue(
      "MODEL_PROVIDER_NO_STREAMING",
      "Streaming is enabled but the referenced model provider does not support it.",
    );
  }
  return null;
}

export function agentProviderLimitIssue(agent, provider) {
  const contextWindow = provider.capabilities?.contextWindow;
  const providerOutput = provider.capabilities?.maxOutputTokens;
  if (!Number.isFinite(contextWindow) || !Number.isFinite(providerOutput)) {
    return issueValue(
      "MODEL_PROVIDER_LIMITS_INVALID",
      "The referenced model provider has invalid token capabilities.",
    );
  }
  const output = agent.limits.maxOutputTokens ?? provider.capabilities.maxOutputTokens;
  const input =
    agent.limits.maxInputTokens ?? provider.capabilities.contextWindow - output;
  if (output > providerOutput) {
    return issueValue(
      "MODEL_LIMITS_INVALID",
      "Agent maxOutputTokens exceeds the model provider capability.",
    );
  }
  if (input + output > contextWindow) {
    return issueValue(
      "MODEL_LIMITS_INVALID",
      "Agent input and output limits exceed the provider context window.",
    );
  }
  return null;
}

function objectIds(values) {
  return [...values]
    .filter((value) => mongoose.isValidObjectId(value))
    .map((value) => new mongoose.Types.ObjectId(value));
}

function byId(documents) {
  return new Map(documents.map((document) => [document._id.toString(), document]));
}

function without(value, fields) {
  const result = { ...value };
  for (const field of fields) delete result[field];
  return result;
}

function mergeSecretMap(existing = {}, incoming) {
  return Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => [
      key,
      value === "" && existing[key] !== undefined ? existing[key] : value,
    ]),
  );
}

/** Existing records predate the console validation, so list/detail responses
 * defensively remove URL userinfo and query values even when a legacy record is
 * malformed. The invocation validator will refuse that record until corrected. */
function safeEndpoint(value) {
  if (value === undefined || value === null || value === "") {
    return { value, redacted: false };
  }
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { value: undefined, redacted: true };
    }
    const redacted = Boolean(url.username || url.password || url.search || url.hash);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { value: url.toString(), redacted };
  } catch {
    return { value: undefined, redacted: true };
  }
}

function issueValue(code, message) {
  return { code, message };
}

/**
 * A raw Node stdio command needs a local JavaScript entry point. When its first
 * positional argument is an HTTP URL, Node treats that URL as a module path
 * (`/app/https:/...`) and fails before an MCP handshake can begin. This is a
 * deterministic configuration error, not a transient AgentCore failure.
 */
export function mcpConfigurationIssue(document) {
  const value = plain(document);
  if (value.transport !== "stdio") return null;
  const launcher = executableName(value.command);
  const args = (value.args ?? []).filter((argument) => typeof argument === "string");
  const invalidEntry = invalidHttpLauncherEntry(launcher, args);
  const combinedNpxArgument =
    launcher === "npx" &&
    args.some((argument) => /^(?:-y|--yes)\s+\S/.test(argument.trim()));
  if (!invalidEntry && !combinedNpxArgument) return null;
  const guidance =
    launcher === "node"
      ? "Configure it as HTTP with that URL and the required authentication instead."
      : "Pass the package and each option as separate arguments, or configure HTTP transport if the URL is the MCP endpoint.";
  return issueValue(
    "MCP_CONFIGURATION_INVALID",
    "MCP server " +
      value.name +
      " launches stdio with " +
      launcher +
      (invalidEntry
        ? " but uses an HTTP URL where a package or entry command is required. "
        : " but combines the npx yes flag, package, and options into one argument. ") +
      guidance,
  );
}

function executableName(command) {
  return String(command ?? "")
    .trim()
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd)$/i, "");
}

function invalidHttpLauncherEntry(launcher, args) {
  const isHttp = (value) => /^https?:\/\//i.test(value ?? "");
  if (launcher === "node") {
    return isHttp(args.find((argument) => !argument.startsWith("-")));
  }
  if (!["npx", "npm", "yarn", "pnpm"].includes(launcher)) return false;
  if (isHttp(args[0])) return true;

  if (launcher === "npx") {
    let index = 0;
    while (["-y", "--yes", "--no-install", "--quiet", "--"].includes(args[index])) {
      index += 1;
    }
    return isHttp(args[index]);
  }

  const subcommands =
    launcher === "npm" ? ["exec", "x"] : ["dlx", "exec", "x"];
  if (!subcommands.includes(args[0])) return false;
  let index = 1;
  while (["-y", "--yes", "--quiet", "--"].includes(args[index])) index += 1;
  return isHttp(args[index]);
}

function payloadIdentifier(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)
    ? normalized
    : fallback.slice(0, 100);
}
