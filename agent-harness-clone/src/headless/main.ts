#!/usr/bin/env node
import path from 'node:path';
import { scrubbedEnvironment } from '../runtime/local-runtime-host.js';
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
  logger: (message) => process.stderr.write(`${message}\n`),
});

process.stdout.write(
  [
    `Headless runtime listening at ${running.url}`,
    'contract=POST /invocations (payload in body), GET /ping',
    'streaming=Accept: text/event-stream, or ?stream=true',
    `auth=${serviceKey ? 'x-agent-service-key' : 'NONE'}`,
    `permissionCeiling=${permissionCeiling ?? 'none (payload decides)'}`,
    `shellEnvExtras=${shellEnvironmentExtras.join(',') || 'none'}`,
  ].join('\n') + '\n',
);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await running.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

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
