#!/usr/bin/env node
import path from 'node:path';
import { scrubbedEnvironment } from '../runtime/local-runtime-host.js';
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
// Names this deployment's tools need beyond the allowlist, such as a proxy setting.
// Everything else in the process environment is withheld from spawned commands.
const shellEnvironmentExtras = (process.env.AGENT_SHELL_ENV_ALLOWLIST ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
/**
 * Written to stdout, which is the log AgentCore already collects.
 *
 * There is no log group to configure here. AgentCore forwards this process's stdout
 * into a stream it names itself — `<date>/[runtime-logs]<runtime session id>` — and
 * that name is the runtime's to choose, not something an application inside the
 * container can redirect. Since the id in it is the runtime session, those streams are
 * already one per session: invocations sharing a `runtimeSessionId` share a stream,
 * and a caller that omits it gets a new session, and so a new stream, every time.
 *
 * Grouping is therefore decided by the caller reusing its session id, and the work
 * this process does is to make that grouping legible: every line carries `sessionId`,
 * so one session reads as one story whichever stream it lands in.
 *
 * `logSink` covers both the invocation lifecycle and session AgentEvents. It is not
 * also passed as `eventSink`, because the session would then write every event twice.
 */
const logSink = new StructuredLogSink((line) => process.stdout.write(`${line}\n`), {
  context: {},
});

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
