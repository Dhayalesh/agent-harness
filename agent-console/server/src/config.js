/**
 * Every value this process needs, read once at startup.
 *
 * Nothing here configures an agent — agents live in MongoDB. What the environment
 * sets is where this API listens, which database it opens, and which AgentCore
 * Runtime it invokes.
 */

const trimmed = (name, fallback = "") => (process.env[name] ?? fallback).trim();

const integer = (name, fallback) => {
  const raw = trimmed(name);
  if (raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
};

/**
 * `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<name>`
 *
 * The partition is left open (`aws`, `aws-cn`, `aws-us-gov`) but the service and
 * resource type are pinned: an ARN for some other service is a request that would
 * fail deep inside the SDK with a message that does not mention the ARN.
 */
export const RUNTIME_ARN_PATTERN =
  /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/[A-Za-z0-9_.:-]+$/;

/** The region and account an ARN names, or null if it is not a runtime ARN. */
export function parseRuntimeArn(arn) {
  const match = RUNTIME_ARN_PATTERN.exec(arn ?? "");
  if (!match) return null;
  return { region: match[1], accountId: match[2] };
}

const runtimeArn = trimmed("AGENTCORE_RUNTIME_ARN");
const parsedArn = parseRuntimeArn(runtimeArn);
const regionOverride = trimmed("AWS_REGION") || trimmed("AWS_DEFAULT_REGION");

if (runtimeArn && !parsedArn) {
  throw new Error(
    `AGENTCORE_RUNTIME_ARN is not an AgentCore runtime ARN: "${runtimeArn}". Expected ` +
      "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<name>",
  );
}

export const config = {
  host: trimmed("HOST", "127.0.0.1"),
  port: integer("PORT", 4000),
  mongoUri: trimmed("MONGODB_URI", "mongodb://127.0.0.1:27017/agent_console"),
  // MongoDB silently chooses a database named test when the URI has no path.
  // Keep a connection-only Atlas URI safe by giving this app its own fallback DB.
  mongoDbName:
    trimmed("MONGODB_DB_NAME") || databaseNameFallback(trimmed("MONGODB_URI")),
  corsOrigins: trimmed("CORS_ORIGIN", "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  agentcore: {
    /** Default runtime. An agent record may name its own instead. */
    runtimeArn,
    qualifier: trimmed("AGENTCORE_QUALIFIER"),
    /**
     * An explicit region wins, otherwise the ARN's own region. Deriving it is worth
     * the few lines: a client pointed at the wrong region does not fail with
     * "wrong region", it fails with ResourceNotFound on an ARN that plainly exists.
     */
    region: regionOverride || parsedArn?.region,
    // Kept separately so a per-agent ARN can use its own region unless the operator
    // deliberately pinned every AWS call to one region.
    regionOverride,
    profile: trimmed("AWS_PROFILE"),
    timeoutMs: integer("AGENTCORE_TIMEOUT_MS", 900_000),
  },
  artifacts: {
    // Must match the private bucket configured on the harness. Keeping the
    // allowlisted bucket here prevents a runtime event from becoming arbitrary
    // S3 read access through the console-owned chat endpoint.
    bucket: trimmed("AGENT_SESSION_S3_BUCKET"),
    prefix: trimmed("AGENT_S3_ARTIFACT_PREFIX", "artifacts").replace(
      /^\/+|\/+$/g,
      "",
    ),
    region: regionOverride || parsedArn?.region,
    requestTimeoutMs: integer("AGENT_SESSION_S3_REQUEST_TIMEOUT_MS", 10_000),
    maxBytes: integer("AGENT_ARTIFACT_MAX_BYTES", 25 * 1024 * 1024),
  },
  uploads: {
    /** Per file, enforced by the multipart parser before anything is buffered. */
    maxFileBytes: integer("CHAT_UPLOAD_MAX_FILE_BYTES", 25 * 1024 * 1024),
    maxFiles: integer("CHAT_UPLOAD_MAX_FILES", 10),
    /**
     * Extracted text kept per attachment. Text is what reaches the model, so this
     * is the real context cost of an upload, not the file size.
     */
    maxTextChars: integer("CHAT_UPLOAD_MAX_TEXT_CHARS", 200_000),
    /** Total extracted text across every attachment on one message. */
    maxPromptChars: integer("CHAT_UPLOAD_MAX_PROMPT_CHARS", 600_000),
    /**
     * Images travel to the model as base64, which inflates by a third and has to
     * fit the console's 5 MB JSON body and the harness's 8 MB one.
     */
    maxImageBytes: integer("CHAT_UPLOAD_MAX_IMAGE_BYTES", 4 * 1024 * 1024),
    /**
     * Ceiling for keeping original bytes in MongoDB when S3 is not configured.
     * Well below the 16 MB BSON document limit, since the bytes sit in a document
     * alongside their metadata.
     */
    maxInlineBytes: integer("CHAT_UPLOAD_MAX_INLINE_BYTES", 2 * 1024 * 1024),
    /** Sibling of the artifact prefix, in the same private bucket. */
    prefix: trimmed("AGENT_S3_UPLOAD_PREFIX", "uploads").replace(
      /^\/+|\/+$/g,
      "",
    ),
  },
  chatTitles: {
    /**
     * Name a new chat from its first exchange using the agent's own model provider.
     * Turning this off keeps the placeholder name; it does not disable the
     * prompt-derived fallback, which costs nothing and always runs.
     */
    enabled: trimmed("CHAT_AUTO_TITLE", "true").toLowerCase() !== "false",
    timeoutMs: integer("CHAT_TITLE_TIMEOUT_MS", 8_000),
    maxLength: integer("CHAT_TITLE_MAX_LENGTH", 60),
  },
  createdBy: trimmed("PLATFORM_CREATED_BY", "agent-console"),
};

/** Providers with an adapter in the currently deployed harness. */
export const SUPPORTED_MODEL_PROVIDERS = ["openrouter", "openai-compatible"];

/** Every tool the harness can build across its supported hosts. */
const KNOWN_TOOLS = [
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "bash",
  "powershell",
  "todo_write",
  "web_fetch",
  "web_search",
];

/**
 * Tools the Linux AgentCore image offers without optional deployment credentials.
 * PowerShell is explicitly disabled in the image and web_search is absent unless the
 * runtime has TAVILY_API_KEY. AGENT_RUNTIME_TOOLS lets an operator publish the exact
 * catalogue when the deployment enables optional or custom capabilities.
 */
const DEFAULT_RUNTIME_TOOLS = [
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "bash",
  "todo_write",
  "web_fetch",
];

export const AVAILABLE_TOOLS = configuredRuntimeTools();

/** Tools that only observe. Used to describe an agent's blast radius in the UI. */
export const READ_ONLY_TOOLS = [
  "read_file",
  "glob",
  "grep",
  "todo_write",
  "web_fetch",
  "web_search",
];

function configuredRuntimeTools() {
  const configured = trimmed("AGENT_RUNTIME_TOOLS");
  if (!configured) return DEFAULT_RUNTIME_TOOLS;

  const tools = [
    ...new Set(
      configured
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
  const unknown = tools.filter((tool) => !KNOWN_TOOLS.includes(tool));
  if (unknown.length) {
    throw new Error(
      "AGENT_RUNTIME_TOOLS contains unsupported tool names: " +
        unknown.join(", ") +
        ". Known tools: " +
        KNOWN_TOOLS.join(", "),
    );
  }
  return tools;
}

function databaseNameFallback(uri) {
  if (!uri) return "trueai_agent_platform";
  try {
    return new URL(uri).pathname.replace(/^\/+/, "")
      ? undefined
      : "trueai_agent_platform";
  } catch {
    // Let Mongoose produce the useful URI parsing error during connect.
    return undefined;
  }
}
