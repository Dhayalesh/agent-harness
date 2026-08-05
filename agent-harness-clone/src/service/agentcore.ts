#!/usr/bin/env node
import path from 'node:path';
import { AGENTCORE_HOST, AGENTCORE_PORT } from '../adapters/server/agentcore-server.js';
import type { PermissionMode } from '../permissions/rule-permission-handler.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import { scrubbedEnvironment } from '../runtime/local-runtime-host.js';
import { startAgentCoreRuntime } from './agentcore-runtime.js';

const workspace = path.resolve(
  process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), '.agentcore', 'workspace'),
);
const dataDirectory = path.resolve(
  process.env.AGENT_DATA_DIR ?? path.join(process.cwd(), '.agentcore', 'data'),
);
const permissionMode = parsePermissionMode(process.env.AGENT_PERMISSION_MODE ?? 'default');
const host = process.env.AGENT_SERVICE_HOST ?? AGENTCORE_HOST;
const port = parsePort(process.env.AGENT_SERVICE_PORT ?? String(AGENTCORE_PORT));
// Names this deployment's tools need beyond the allowlist, such as a proxy
// setting. Everything else in the process environment is withheld from commands.
const shellEnvironmentExtras = (process.env.AGENT_SHELL_ENV_ALLOWLIST ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const runtime = await startAgentCoreRuntime({
  workspace,
  dataDirectory,
  host,
  port,
  shellEnvironment: scrubbedEnvironment(process.env, shellEnvironmentExtras),
  agentCacheOptions: { logger: (message) => process.stderr.write(`${message}\n`) },
  // PowerShell is gated on the host offering it, and a Linux ARM64 container does
  // not. Naming it here keeps the tool catalogue identical between the image and a
  // developer's Windows machine, so `agents.tools` validates the same in both.
  builtinToolOptions: { powershell: false },
  createPermissionHandler: () =>
    // `fallback: 'deny'` rather than `'ask'`: asking suspends the run until a
    // second invocation answers, and a caller that does not implement that reply
    // would hang until the session timed out. A record that needs a tool should
    // say so through its own rules, not through a prompt nobody is watching.
    new RulePermissionHandler({ mode: permissionMode, fallback: 'deny' }),
});

process.stdout.write(
  [
    `AgentCore runtime listening at ${runtime.url}`,
    'contract=POST /invocations, GET /ping',
    `workspace=${workspace} (one directory per session)`,
    `permissionMode=${permissionMode}`,
    `shellEnvExtras=${shellEnvironmentExtras.join(',') || 'none'}`,
  ].join('\n') + '\n',
);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await runtime.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function parsePermissionMode(value: string): PermissionMode {
  if (value === 'bypass' && process.env.AGENT_ALLOW_BYPASS !== '1') {
    throw new Error(
      'AGENT_PERMISSION_MODE=bypass allows every tool call without a check, including shell ' +
        'commands, on a runtime several applications share. Set AGENT_ALLOW_BYPASS=1 to confirm.',
    );
  }
  if (value === 'default' || value === 'plan' || value === 'bypass' || value === 'deny') {
    return value;
  }
  throw new Error(`Invalid AGENT_PERMISSION_MODE: ${value}`);
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid AGENT_SERVICE_PORT: ${value}`);
  }
  return parsed;
}
