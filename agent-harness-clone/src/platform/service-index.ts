#!/usr/bin/env node
import path from 'node:path';
import { startMongoAgentPlatform } from './mongodb-platform-service.js';

const mongoUri = requiredEnvironment('MONGODB_URI');
const bootstrapApiKey = requiredEnvironment('PLATFORM_BOOTSTRAP_API_KEY');
const service = await startMongoAgentPlatform({
  mongoUri,
  databaseName: process.env.MONGODB_DATABASE ?? 'trueai_agent_platform',
  bootstrapApiKey,
  bootstrapTenantId: process.env.PLATFORM_BOOTSTRAP_TENANT ?? 'default',
  workspaceRoot: path.resolve(
    process.env.PLATFORM_WORKSPACE_ROOT ??
      path.join(process.cwd(), '.agent-platform', 'workspaces'),
  ),
  artifactRoot: path.resolve(
    process.env.PLATFORM_ARTIFACT_ROOT ?? path.join(process.cwd(), '.agent-platform', 'artifacts'),
  ),
  host: process.env.PLATFORM_HOST ?? '127.0.0.1',
  port: parsePort(process.env.PLATFORM_PORT ?? '8788'),
});

process.stdout.write(`Agent platform listening at ${service.url}\n`);
process.stdout.write('executionMode=synchronous-api-process\n');

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await service.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid PLATFORM_PORT: ${value}`);
  }
  return parsed;
}
