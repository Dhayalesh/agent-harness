#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { scrubbedEnvironment } from '../runtime/local-runtime-host.js';
import { CloudWatchLogWriter } from '../services/cloudwatch-log-writer.js';
import { emitLog, parseLogLevel, StructuredLogSink } from '../services/observability.js';
import { FileSessionStore } from '../sessions/file-session-store.js';
import { InMemorySessionStore } from '../sessions/session-store.js';
import { S3SessionStore } from '../sessions/s3-session-store.js';
import { TieredSessionStore } from '../sessions/tiered-session-store.js';
import { HEADLESS_HOST, HEADLESS_PORT, startHeadlessServer } from './server.js';

/**
 * The headless server as a process. `POST /invocations`, `GET /ping`.
 *
 * Every variable it reads is optional, and none of them configures an agent: there is
 * no `PLATFORM_MONGODB_URI`, no model, no credential, and no prompt here, because all
 * of those arrive on the request. What the environment sets is where the process
 * listens and what it will allow a payload to do.
 */

/**
 * Loads `.env` when one sits beside the process, for a developer running this
 * directly. Without it a `.env` is inert here — only `scripts/headless/exportPayload.ts`
 * passed `--env-file`, so settings put there never reached the server and appeared to
 * be ignored.
 *
 * Values already in the environment win: a container's real configuration must not be
 * overridden by a file that happened to get copied into the image. `.dockerignore`
 * excludes `.env` for that reason, so this is a no-op in a deployed image.
 */
try {
  process.loadEnvFile?.('.env');
} catch {
  // No .env, or an unreadable one. Both mean "configure through the environment".
}

const host = process.env.AGENT_SERVICE_HOST ?? HEADLESS_HOST;
const port = parsePort(process.env.AGENT_SERVICE_PORT ?? String(HEADLESS_PORT));
const serviceKey = process.env.AGENT_SERVICE_KEY?.trim();
const workspaceRoot = process.env.AGENT_WORKSPACE
  ? path.resolve(process.env.AGENT_WORKSPACE)
  : undefined;
const permissionCeiling = parseCeiling(process.env.AGENT_PERMISSION_CEILING);
const region = process.env.AWS_REGION?.trim() || process.env.PLATFORM_CONTENT_S3_REGION?.trim();
const sessionStoreKind = parseSessionStore(process.env.AGENT_SESSION_STORE);
const sessionTtlMs =
  parsePositiveInteger(process.env.AGENT_SESSION_TTL_SECONDS, 86_400, 'AGENT_SESSION_TTL_SECONDS') *
  1_000;
const sessionMaxBytes = parsePositiveInteger(
  process.env.AGENT_SESSION_MAX_BYTES,
  10 * 1024 * 1024,
  'AGENT_SESSION_MAX_BYTES',
);
const sessionDirectory = path.resolve(
  process.env.AGENT_SESSION_DIR?.trim() || path.join(os.tmpdir(), 'agent-harness-sessions'),
);
const sessionOptions = { ttlMs: sessionTtlMs, maxBytes: sessionMaxBytes };
const localSessionStore = new FileSessionStore(sessionDirectory, sessionOptions);
const s3SessionStore =
  sessionStoreKind === 's3'
    ? new S3SessionStore({
        bucket: requiredEnvironment('AGENT_SESSION_S3_BUCKET'),
        prefix: process.env.AGENT_SESSION_S3_PREFIX?.trim() || 'sessions',
        ...(region ? { region } : {}),
        requestTimeoutMs: parsePositiveInteger(
          process.env.AGENT_SESSION_S3_REQUEST_TIMEOUT_MS,
          10_000,
          'AGENT_SESSION_S3_REQUEST_TIMEOUT_MS',
        ),
        maxBytes: sessionMaxBytes,
      })
    : undefined;
const sessionStore =
  sessionStoreKind === 'none'
    ? undefined
    : sessionStoreKind === 'memory'
      ? new InMemorySessionStore(sessionOptions)
      : sessionStoreKind === 's3' && s3SessionStore
        ? new TieredSessionStore(localSessionStore, s3SessionStore)
        : localSessionStore;
// Names this deployment's tools need beyond the allowlist, such as a proxy setting.
// Everything else in the process environment is withheld from spawned commands.
const shellEnvironmentExtras = (process.env.AGENT_SHELL_ENV_ALLOWLIST ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
/**
 * Where the log goes: a group this deployment owns, named `agentcore` by default.
 *
 * Left to itself AgentCore forwards stdout into a stream it names — `<date>/
 * [runtime-logs]<runtime session id>` — in a group it also chooses. Neither name is
 * something an application inside the container can influence, which is why one run's
 * logs are only findable by first knowing its runtime session id. Writing directly to
 * a group of our own is the way to pick the layout, and the layout worth picking is
 * the one a run is read back by: one stream per session,
 * `YYYY/MM/DD/<sessionId>`.
 *
 * `AGENT_LOG_GROUP` renames the group; setting it to `-` opts out and returns to
 * plain stdout, for a developer running this without AWS credentials.
 *
 * Lines go to CloudWatch *and* stdout. The writer's own failure path can only report
 * to stderr, so keeping stdout means a run whose CloudWatch delivery is broken is
 * still readable somewhere rather than silently empty.
 */
const logGroupName = (process.env.AGENT_LOG_GROUP?.trim() || 'agentcore').trim();
const logLevel = parseLogLevel(process.env.AGENT_LOG_LEVEL);
// `AWS_REGION` is what the SDK itself reads. `PLATFORM_CONTENT_S3_REGION` is accepted
// after it because a deployment already configured for S3 skill reads has named its
// region once, and making it name the same value twice to get logs is a trap rather
// than a decision.
const cloudWatch =
  logGroupName === '-'
    ? undefined
    : new CloudWatchLogWriter({
        logGroupName,
        ...(region ? { region } : {}),
      });

/**
 * `logSink` covers both the invocation lifecycle and session AgentEvents. It is not
 * also passed as `eventSink`, because the session would then write every event twice.
 *
 * The writer is attached as the sink's `write` callback rather than replacing it, so
 * redaction and oversized-line chunking still happen upstream and are identical
 * whichever destination is in use.
 */
const logSink = new StructuredLogSink(
  (line) => {
    process.stdout.write(`${line}\n`);
    cloudWatch?.write(line);
  },
  { context: {}, minimumLevel: logLevel },
);

const running = await startHeadlessServer({
  host,
  port,
  ...(serviceKey ? { serviceKey } : {}),
  ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  ...(permissionCeiling === undefined ? {} : { permissionCeiling }),
  shellEnvironment: scrubbedEnvironment(process.env, shellEnvironmentExtras),
  // PowerShell is gated on the host offering it, and a Linux container does not.
  // Naming it keeps the tool catalogue identical between the image and a developer's
  // Windows machine, so `agent.tools` in a payload validates the same in both.
  builtinToolOptions: { powershell: false },
  ...(sessionStore === undefined ? {} : { sessionStore }),
  logSink,
});

/**
 * Names the credential variables the SDK will not find, on stderr, at startup.
 *
 * Written to stderr rather than through `logSink`, because when this fires the
 * CloudWatch half of the sink is the broken component and anything sent through it is
 * lost — which is the failure mode itself: a log group configured with credentials
 * under the wrong names receives nothing and reports nothing, so it reads as "logging
 * does not work".
 *
 * Only the ambient names are checked. A container using a task role, an SSO profile,
 * or any other provider in the chain has none of these set and is correctly quiet.
 */
if (cloudWatch) {
  const misnamed = [
    ['AWS_ACCESS_KEY', 'AWS_ACCESS_KEY_ID'],
    ['AWS_SECRET', 'AWS_SECRET_ACCESS_KEY'],
  ].filter(([wrong, right]) => process.env[wrong!] && !process.env[right!]);
  if (misnamed.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        component: 'agent-harness',
        event: 'cloudwatch.credentials.misnamed',
        logGroupName,
        message:
          'Logs are written to a CloudWatch group but the AWS SDK reads different ' +
          'variable names, so delivery will fail with a credentials error. Rename ' +
          'these, or use a task role.',
        rename: Object.fromEntries(misnamed),
      })}\n`,
    );
  }
}

// Structured rather than a plain banner: stdout is a JSON-lines stream, and six bare
// lines of text would arrive as six unparseable CloudWatch records interleaved with
// the run's own logs. As one record it is queryable like everything else, and it is
// the line to look for first when confirming a container came up.
emitLog(logSink, {
  event: 'runtime.started',
  url: running.url,
  contract: 'POST /invocations, GET /ping',
  streaming: 'Accept: text/event-stream, or ?stream=true',
  authenticated: serviceKey !== undefined,
  permissionCeiling: permissionCeiling ?? 'none',
  logDestination: cloudWatch ? `stdout+cloudwatch:${logGroupName}` : 'stdout',
  logLevel,
  sessionStore: sessionStoreKind,
  sessionTtlSeconds: sessionTtlMs / 1_000,
  sessionMaxBytes,
  ...(sessionStoreKind === 'file' || sessionStoreKind === 's3' ? { sessionDirectory } : {}),
  ...(sessionStoreKind === 's3'
    ? {
        sessionS3Bucket: process.env.AGENT_SESSION_S3_BUCKET,
        sessionS3Prefix: process.env.AGENT_SESSION_S3_PREFIX?.trim() || 'sessions',
      }
    : {}),
  ...(cloudWatch && region ? { region } : {}),
  shellEnvExtras: shellEnvironmentExtras,
  pid: process.pid,
  nodeVersion: process.version,
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    await running.close();
  } catch (error) {
    emitLog(logSink, {
      level: 'error',
      event: 'runtime.shutdown.failed',
      error: describeError(error),
    });
    throw error;
  } finally {
    s3SessionStore?.destroy();
    // In `finally` so the shutdown-failure record above is sent too: queued lines
    // live in memory, and an unflushed buffer at exit loses exactly the lines
    // explaining why the process is exiting.
    await cloudWatch?.close().catch(() => undefined);
  }
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.on('uncaughtExceptionMonitor', (error, origin) => {
  emitLog(logSink, {
    level: 'error',
    event: 'runtime.uncaught_exception',
    origin,
    error: describeError(error),
  });
});

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid AGENT_SERVICE_PORT: ${value}`);
  }
  return parsed;
}

/**
 * Caps what a payload may ask for. Unset lets a payload set `bypass`, which allows
 * every tool including shell without a check — appropriate for a single-tenant
 * deployment whose callers are already trusted, and not for a shared one.
 */
function parseCeiling(value: string | undefined): 'plan' | 'deny' | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'none') return undefined;
  if (trimmed === 'plan' || trimmed === 'deny') return trimmed;
  throw new Error(`Invalid AGENT_PERMISSION_CEILING: ${value}. Expected plan, deny, or none.`);
}

function parseSessionStore(value: string | undefined): 'file' | 'memory' | 's3' | 'none' {
  const normalized = value?.trim().toLowerCase() || 'file';
  if (
    normalized === 'file' ||
    normalized === 'memory' ||
    normalized === 's3' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  throw new Error(`Invalid AGENT_SESSION_STORE: ${value}. Expected file, memory, s3, or none.`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when AGENT_SESSION_STORE=s3.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
