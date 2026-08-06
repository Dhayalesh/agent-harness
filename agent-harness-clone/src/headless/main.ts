#!/usr/bin/env node
import path from 'node:path';
import { scrubbedEnvironment } from '../runtime/local-runtime-host.js';
import { CloudWatchLogWriter } from '../services/cloudwatch-log-writer.js';
import { emitLog, StructuredLogSink } from '../services/observability.js';
import { HEADLESS_HOST, HEADLESS_PORT, startHeadlessServer } from './server.js';

/**
 * The headless server as a process. `POST /invocations`, `GET /ping`.
 *
 * Every variable it reads is optional, and none of them configures an agent: there is
 * no `PLATFORM_MONGODB_URI`, no model, no credential, and no prompt here, because all
 * of those arrive on the request. What the environment sets is where the process
 * listens and what it will allow a payload to do.
 */

const host = process.env.AGENT_SERVICE_HOST ?? HEADLESS_HOST;
const port = parsePort(process.env.AGENT_SERVICE_PORT ?? String(HEADLESS_PORT));
const serviceKey = process.env.AGENT_SERVICE_KEY?.trim();
const workspaceRoot = process.env.AGENT_WORKSPACE
  ? path.resolve(process.env.AGENT_WORKSPACE)
  : undefined;
const permissionCeiling = parseCeiling(process.env.AGENT_PERMISSION_CEILING);
// Names this deployment's tools need beyond the allowlist, such as a proxy setting.
// Everything else in the process environment is withheld from spawned commands.
const shellEnvironmentExtras = (process.env.AGENT_SHELL_ENV_ALLOWLIST ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
/**
 * Where the log goes.
 *
 * Unset, lines are written to stdout and AgentCore forwards them to the stream it
 * names, which is one stream per runtime session and not something this process can
 * influence. Setting `AGENT_LOG_GROUP` sends them to a group this deployment owns
 * instead, laid out one stream per session — the grouping an operator actually reads
 * by, and the reason for writing directly rather than through stdout.
 *
 * These are exclusive by choice: duplicating every line into both destinations
 * doubles ingest cost for a second copy nobody queries.
 */
const logGroupName = process.env.AGENT_LOG_GROUP?.trim();
const cloudWatch = logGroupName
  ? new CloudWatchLogWriter({
      logGroupName,
      ...(process.env.AWS_REGION?.trim() ? { region: process.env.AWS_REGION.trim() } : {}),
    })
  : undefined;

/**
 * `logSink` covers both the invocation lifecycle and session AgentEvents. It is not
 * also passed as `eventSink`, because the session would then write every event twice.
 *
 * The writer is attached as the sink's `write` callback rather than replacing it, so
 * redaction and oversized-line chunking still happen upstream and are identical
 * whichever destination is in use.
 */
const logSink = new StructuredLogSink(
  cloudWatch ? cloudWatch.write : (line) => process.stdout.write(`${line}\n`),
  { context: {} },
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
  logSink,
});

// Structured rather than a plain banner: stdout is now a JSON-lines stream, and six
// bare lines of text would arrive as six unparseable CloudWatch records interleaved
// with the run's own logs. As one record it is queryable like everything else, and it
// is the line to look for first when confirming a container came up.
emitLog(logSink, {
  event: 'runtime.started',
  url: running.url,
  contract: 'POST /invocations, GET /ping',
  streaming: 'Accept: text/event-stream, or ?stream=true',
  authenticated: serviceKey !== undefined,
  permissionCeiling: permissionCeiling ?? 'none',
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

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
