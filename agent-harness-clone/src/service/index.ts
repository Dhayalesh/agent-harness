#!/usr/bin/env node
import path from 'node:path';
import { AnthropicModelProvider } from '../models/anthropic-provider.js';
import {
  createOpenRouterProvider,
  OpenAICompatibleModelProvider,
} from '../models/openai-compatible-provider.js';
import type { PermissionMode } from '../permissions/rule-permission-handler.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import { createAgentCoreDemoProvider, startAgentCoreService } from './agent-core-service.js';

const providerName = process.env.AGENT_PROVIDER ?? 'demo';
const workspace = path.resolve(
  process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), '.agent-core-demo', 'workspace'),
);
const dataDirectory = path.resolve(
  process.env.AGENT_DATA_DIR ?? path.join(process.cwd(), '.agent-core-demo', 'data'),
);
const permissionMode = parsePermissionMode(process.env.AGENT_PERMISSION_MODE ?? 'default');
const port = parsePort(process.env.AGENT_SERVICE_PORT ?? '8787');

const service = await startAgentCoreService({
  workspace,
  dataDirectory,
  host: process.env.AGENT_SERVICE_HOST ?? '127.0.0.1',
  port,
  ...(process.env.AGENT_SERVICE_KEY === undefined
    ? {}
    : { serviceKey: process.env.AGENT_SERVICE_KEY }),
  createPermissionHandler: () => new RulePermissionHandler({ mode: permissionMode }),
  createProvider: () => {
    if (providerName === 'demo') return createAgentCoreDemoProvider();
    if (providerName === 'openrouter') {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is required when AGENT_PROVIDER=openrouter');
      }
      if (!process.env.AGENT_MODEL) {
        throw new Error('AGENT_MODEL is required when AGENT_PROVIDER=openrouter');
      }
      return createOpenRouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultModel: process.env.AGENT_MODEL,
        ...(process.env.OPENROUTER_APP_URL === undefined
          ? {}
          : { appUrl: process.env.OPENROUTER_APP_URL }),
        ...(process.env.OPENROUTER_APP_NAME === undefined
          ? {}
          : { appName: process.env.OPENROUTER_APP_NAME }),
      });
    }
    if (providerName === 'openai-compatible') {
      const apiKey = process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!apiKey || !process.env.AGENT_MODEL || !process.env.MODEL_BASE_URL) {
        throw new Error(
          'MODEL_API_KEY, MODEL_BASE_URL, and AGENT_MODEL are required for openai-compatible',
        );
      }
      return new OpenAICompatibleModelProvider({
        apiKey,
        baseURL: process.env.MODEL_BASE_URL,
        defaultModel: process.env.AGENT_MODEL,
      });
    }
    if (providerName === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required when AGENT_PROVIDER=anthropic');
      }
      return new AnthropicModelProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.AGENT_MODEL === undefined ? {} : { defaultModel: process.env.AGENT_MODEL }),
        ...(process.env.ANTHROPIC_BASE_URL === undefined
          ? {}
          : { baseURL: process.env.ANTHROPIC_BASE_URL }),
      });
    }
    throw new Error(`Unsupported AGENT_PROVIDER: ${providerName}`);
  },
});

process.stdout.write(
  [
    `Agent-core service listening at ${service.url}`,
    `provider=${providerName}`,
    `workspace=${workspace}`,
    `permissionMode=${permissionMode}`,
  ].join('\n') + '\n',
);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await service.close();
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
