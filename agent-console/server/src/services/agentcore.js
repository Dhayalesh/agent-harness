import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { config, parseRuntimeArn } from "../config.js";
import { badGateway, badRequest, HttpError } from "../lib/http-error.js";
import { runtimeResultSchema } from "../lib/schemas.js";

/**
 * The only place this API runs an agent.
 *
 * One call: `InvokeAgentRuntime` against a deployed runtime ARN. There is no local
 * transport and no HTTP fallback — a run either reaches AgentCore or it does not
 * happen. That is the point of the change: the thing being invoked is a cloud
 * resource identified by ARN, not a process on someone's laptop.
 *
 * The payload is unchanged from the local contract. The harness image serves the
 * AgentCore Runtime contract on 8080, so what used to be the body of
 * `POST /invocations` is now the `payload` blob of the API call, byte for byte.
 */

/**
 * One client, reused.
 *
 * Built lazily rather than at import time so a missing ARN is a 400 on the one route
 * that needs it instead of a process that will not start — the agent list and the
 * forms work fine without AWS configured, and refusing to boot would hide that.
 */
const clients = new Map();

function agentcoreClient(region) {
  if (clients.has(region)) return clients.get(region);
  if (!region) {
    throw badRequest(
      "No AWS region: set AWS_REGION, or set AGENTCORE_RUNTIME_ARN so the region can be read " +
        "from it.",
    );
  }
  const client = new BedrockAgentCoreClient({
    region,
    // A run legitimately takes minutes, and the SDK's default socket timeout is far
    // shorter than that. AgentCore itself caps a non-streaming invocation at 15
    // minutes, which is what AGENTCORE_TIMEOUT_MS defaults to.
    requestHandler: { requestTimeout: config.agentcore.timeoutMs },
    // InvokeAgentRuntime is not documented as idempotent. An automatic retry can be
    // a second model run that spends tokens and changes the workspace again.
    maxAttempts: 1,
  });
  clients.set(region, client);
  return client;
}

/**
 * Which runtime a given agent invokes, and whether that is answerable at all.
 *
 * A per-agent ARN wins over the environment default, the same way a per-agent model
 * key wins over `DEFAULT_MODEL_API_KEY`. One deployed runtime can serve every agent —
 * it holds no configuration, so the payload decides what runs — and the override
 * exists for the case where it should not.
 */
export function resolveRuntime(agent) {
  const arn = (
    agent?.agentRuntimeArn ||
    config.agentcore.runtimeArn ||
    ""
  ).trim();
  if (!arn) {
    throw badRequest(
      `Agent "${agent?.name ?? "unknown"}" has no agentRuntimeArn and AGENTCORE_RUNTIME_ARN is ` +
        "unset, so there is no AgentCore runtime to invoke.",
    );
  }
  const parsed = parseRuntimeArn(arn);
  if (!parsed) {
    throw badRequest(
      `"${arn}" is not an AgentCore runtime ARN. Expected ` +
        "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<name>",
    );
  }
  return {
    arn,
    region: config.agentcore.regionOverride || parsed.region,
    accountId: parsed.accountId,
    qualifier:
      (
        agent?.agentRuntimeQualifier ||
        config.agentcore.qualifier ||
        ""
      ).trim() || undefined,
  };
}

/**
 * Confirms the app could invoke, without invoking.
 *
 * Resolving the credential chain is the honest check: it is the step that actually
 * fails on an unconfigured machine, and it costs nothing. A probe invocation would
 * spend tokens to tell us something we can learn for free, and calling a control-plane
 * describe would demand a second IAM permission purely so a banner could be green.
 */
export async function checkAgentcore() {
  const configured = Boolean(config.agentcore.runtimeArn);
  const base = {
    runtimeArn: config.agentcore.runtimeArn || null,
    qualifier: config.agentcore.qualifier || "DEFAULT",
    region: config.agentcore.region || null,
    profile: config.agentcore.profile || null,
    runtimeArnConfigured: configured,
  };

  if (!config.agentcore.region) {
    return {
      ...base,
      ready: false,
      error: "No region: set AWS_REGION or AGENTCORE_RUNTIME_ARN.",
    };
  }

  try {
    const identity = await agentcoreClient(
      config.agentcore.region,
    ).config.credentials();
    return {
      ...base,
      ready: true,
      // Enough to tell which identity is in play without printing the secret.
      accessKeyId: mask(identity.accessKeyId),
      credentialSource: identity.accountId
        ? `account ${identity.accountId}`
        : "resolved",
      // Present on temporary credentials; its absence means long-lived keys.
      expiresAt: identity.expiration
        ? new Date(identity.expiration).toISOString()
        : null,
    };
  } catch (error) {
    return {
      ...base,
      ready: false,
      error: `No AWS credentials resolved: ${error?.message ?? error}`,
    };
  }
}

/**
 * Invokes the runtime and returns the harness result.
 *
 * A failure inside the turn arrives as a normal 200 whose body carries
 * `status: 'error'` and the partial output, so that is a normal return here rather
 * than a throw — a run that spent tokens and then hit a model error produced
 * something worth recording. Only a call the service refused becomes an HttpError.
 */
export async function invokeAgentRuntime({
  runtime,
  payload,
  runtimeSessionId,
  traceId,
}) {
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtime.arn,
    qualifier: runtime.qualifier,
    runtimeSessionId,
    contentType: "application/json",
    // Ask for JSON explicitly. Requesting the stream instead would hand back SSE
    // frames of AgentEvent, which is a different shape than the result this records.
    accept: "application/json",
    traceId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });

  let response;
  try {
    response = await agentcoreClient(runtime.region).send(command);
  } catch (error) {
    throw translate(error, runtime);
  }

  const body = await readResponse(response);

  // The runtime's own HTTP status, distinct from the API call succeeding. A non-2xx
  // here means the container answered and refused.
  if (response.statusCode && response.statusCode >= 400) {
    const detail =
      typeof body === "object" && body?.error ? body.error : truncate(body);
    throw badGateway(
      `The runtime rejected the payload (HTTP ${response.statusCode}): ${detail}`,
    );
  }
  if (typeof body !== "object" || body === null) {
    throw badGateway(
      `The runtime returned a body that is not a JSON object: ${truncate(body)}`,
    );
  }

  return {
    result: validateRuntimeResult(body),
    runtimeSessionId: response.runtimeSessionId ?? runtimeSessionId,
    traceId: response.traceId,
    statusCode: response.statusCode ?? 200,
  };
}

/** Refuses a successful HTTP response that is not the hosted harness contract. */
function validateRuntimeResult(body) {
  const parsed = runtimeResultSchema.safeParse(body);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.join(".") || "(root)") + ": " + issue.message)
    .join("; ");
  throw badGateway("The runtime returned an invalid harness result: " + issues);
}

/** Consumes the SDK response stream exactly once and decodes its JSON body. */
async function readResponse(response) {
  const raw = response.response;
  if (!raw) return null;

  const text =
    typeof raw.transformToString === "function"
      ? await raw.transformToString()
      : new TextDecoder().decode(raw);

  if (!text.trim()) return null;

  // We asked for JSON, but a runtime configured to stream answers with SSE regardless
  // of Accept. Saying so beats a JSON.parse error on a line reading `data: {...}`.
  if (
    (response.contentType ?? "").includes("text/event-stream") ||
    text.startsWith("event:")
  ) {
    throw badGateway(
      "The runtime answered with an SSE stream rather than a JSON result. This app records a " +
        "completed run, so it needs the buffered response.",
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * SDK exceptions into statuses and messages that name the fix.
 *
 * The service's own messages are accurate but context-free: `ResourceNotFoundException`
 * on a correct-looking ARN is almost always the wrong region or a runtime that was
 * never deployed, and neither is guessable from the raw error.
 */
function translate(error, runtime) {
  const name = error?.name ?? "";
  const message = error?.message ?? String(error);
  const where = `${runtime.arn} in ${runtime.region}`;
  // `UnrecognizedClientException` and `InvalidSignatureException` arrive by name too.
  if (
    name === "UnrecognizedClientException" ||
    name === "InvalidSignatureException"
  ) {
    return badGateway(
      `AWS rejected the credentials, not the permissions: ${message}. Refresh them — ` +
        "`aws sso login`, a new session token, or a corrected AWS_PROFILE.",
    );
  }

  // A bad or expired credential comes back as a 403 too, and the fix is the opposite of
  // the one an authorisation failure needs: refresh the session, do not widen the policy.
  if (
    /security token|expired|InvalidSignature|not authorized to perform: sts/i.test(
      message,
    )
  ) {
    return badGateway(
      `AWS rejected the credentials, not the permissions: ${message}. Refresh them — ` +
        "`aws sso login`, a new session token, or a corrected AWS_PROFILE.",
    );
  }

  switch (name) {
    case "AccessDeniedException":
      return new HttpError(
        502,
        `Not authorised to invoke ${where}. The caller needs ` +
          `bedrock-agentcore:InvokeAgentRuntime on that runtime. (${message})`,
      );
    case "ResourceNotFoundException":
      return new HttpError(
        502,
        `No AgentCore runtime found at ${where}. Check the ARN, and check the region matches ` +
          `the one in it${runtime.qualifier ? `, and that the "${runtime.qualifier}" endpoint exists` : ""}. (${message})`,
      );
    case "ValidationException":
      return new HttpError(400, `AgentCore rejected the request: ${message}`);
    case "ThrottlingException":
      return new HttpError(429, `AgentCore throttled the request: ${message}`);
    case "ServiceQuotaExceededException":
      return new HttpError(429, `AgentCore quota exceeded: ${message}`);
    case "RetryableConflictException":
      return new HttpError(
        409,
        `AgentCore reported a retryable conflict: ${message}`,
      );
    case "RuntimeClientError":
      return badGateway(
        `The runtime container failed to handle the request: ${message}`,
      );
    case "InternalServerException":
      return badGateway(`AgentCore internal error, safe to retry: ${message}`);
    case "TimeoutError":
    case "RequestTimeout":
      return badGateway(
        `The invocation exceeded AGENTCORE_TIMEOUT_MS (${config.agentcore.timeoutMs}ms). ` +
          "AgentCore caps a non-streaming run at 15 minutes; a longer turn has to stream.",
      );
    default:
      break;
  }

  // A credential chain that resolves to nothing surfaces under several names, none of
  // which say "configure AWS".
  if (/credential/i.test(message)) {
    return badGateway(
      `No usable AWS credentials: ${message}. Set AWS_PROFILE, run \`aws sso login\`, or ` +
        "supply keys in the environment.",
    );
  }
  return badGateway(
    `InvokeAgentRuntime failed (${name || "unknown error"}): ${message}`,
  );
}

const mask = (value) =>
  typeof value === "string" && value.length > 4
    ? `****${value.slice(-4)}`
    : null;

const truncate = (value) => String(value ?? "").slice(0, 300);
