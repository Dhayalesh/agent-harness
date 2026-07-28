#!/usr/bin/env node
import path from 'node:path';
import type { PermissionMode } from '../permissions/rule-permission-handler.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import { resolveModelProviderFromDatabase } from '../platform/model-provider-resolution.js';
import { startAgentCoreService } from './agent-core-service.js';

const workspace = path.resolve(
  process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), '.agent-core-demo', 'workspace'),
);
const dataDirectory = path.resolve(
  process.env.AGENT_DATA_DIR ?? path.join(process.cwd(), '.agent-core-demo', 'data'),
);
const permissionMode = parsePermissionMode(process.env.AGENT_PERMISSION_MODE ?? 'default');
const port = parsePort(process.env.AGENT_SERVICE_PORT ?? '8787');

// Resolved once, before the listener opens, so a misconfigured record fails at
// startup instead of on the first session.
const { provider, record, close: closeModelProvider } = await resolveModelProviderFromDatabase();

const service = await startAgentCoreService({
  workspace,
  dataDirectory,
  host: process.env.AGENT_SERVICE_HOST ?? '127.0.0.1',
  port,
  ...(process.env.AGENT_SERVICE_KEY === undefined
    ? {}
    : { serviceKey: process.env.AGENT_SERVICE_KEY }),
  createPermissionHandler: () => new RulePermissionHandler({ mode: permissionMode }),
  createProvider: () => provider,
});

process.stdout.write(
  [
    `Agent-core service listening at ${service.url}`,
    `provider=${record.name} (${record.provider})`,
    `model=${record.model}`,
    `workspace=${workspace}`,
    `permissionMode=${permissionMode}`,
  ].join('\n') + '\n',
);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await service.close();
  await closeModelProvider();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function parsePermissionMode(value: string): PermissionMode {
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
