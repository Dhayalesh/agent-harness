import type { RuntimeHost } from '../runtime/runtime-host.js';
import type { Db, Document, Filter } from 'mongodb';
import { FileSnapshotStore } from '../tools/builtin/file-snapshots.js';
import { createBashTool } from '../tools/builtin/bash.js';
import { createEditFileTool } from '../tools/builtin/edit-file.js';
import { createGlobTool } from '../tools/builtin/glob.js';
import { createGrepTool } from '../tools/builtin/grep.js';
import { createReadFileTool } from '../tools/builtin/read-file.js';
import { createWriteFileTool } from '../tools/builtin/write-file.js';
import type { Tool } from '../tools/tool.js';
import type {
  DataSourceBinding,
  McpServerBinding,
  PlatformPrincipal,
  ToolBinding,
} from './definitions.js';

export type ToolFactoryContext = {
  runtime: RuntimeHost;
  shared: Map<string, unknown>;
};

export type ToolFactory = (binding: ToolBinding, context: ToolFactoryContext) => Tool;

export class TrustedToolCatalog {
  private readonly factories = new Map<string, ToolFactory>();

  register(name: string, version: string, factory: ToolFactory): () => void {
    const key = catalogKey(name, version);
    if (this.factories.has(key)) throw new Error(`Tool factory already registered: ${key}`);
    this.factories.set(key, factory);
    return () => this.factories.delete(key);
  }

  resolve(bindings: readonly ToolBinding[], runtime: RuntimeHost): Tool[] {
    const context: ToolFactoryContext = { runtime, shared: new Map() };
    return bindings.map((binding) => {
      const factory = this.factories.get(catalogKey(binding.name, binding.version));
      if (!factory) {
        throw new Error(
          `Untrusted or unavailable tool binding: ${binding.name}@${binding.version}`,
        );
      }
      const tool = factory(structuredClone(binding), context);
      if (tool.name !== binding.name) {
        throw new Error(`Tool factory ${binding.name}@${binding.version} returned ${tool.name}`);
      }
      return tool;
    });
  }
}

export class TrustedMcpServerCatalog {
  private readonly servers = new Map<string, McpServerBinding>();

  register(binding: McpServerBinding): () => void {
    const key = catalogKey(binding.name, binding.version);
    if (this.servers.has(key)) throw new Error(`MCP server already registered: ${key}`);
    this.servers.set(key, structuredClone(binding));
    return () => this.servers.delete(key);
  }

  assertTrusted(binding: McpServerBinding): void {
    const key = catalogKey(binding.name, binding.version);
    const trusted = this.servers.get(key);
    if (!trusted) throw new Error(`Untrusted or unavailable MCP server binding: ${key}`);
    const sameTransport = trusted.transport === binding.transport;
    const sameEndpoint =
      binding.transport === 'stdio'
        ? trusted.command === binding.command &&
          JSON.stringify(trusted.args ?? []) === JSON.stringify(binding.args ?? [])
        : normalizeEndpoint(trusted.url) === normalizeEndpoint(binding.url);
    if (!sameTransport || !sameEndpoint) {
      throw new Error(`MCP server binding does not match trusted configuration: ${key}`);
    }
  }
}

export function registerBuiltinToolCatalog(catalog: TrustedToolCatalog): void {
  const snapshots = (context: ToolFactoryContext): FileSnapshotStore => {
    const existing = context.shared.get('builtin-file-snapshots');
    if (existing instanceof FileSnapshotStore) return existing;
    const created = new FileSnapshotStore();
    context.shared.set('builtin-file-snapshots', created);
    return created;
  };
  catalog.register('read_file', '1', (binding, context) =>
    createReadFileTool(
      context.runtime,
      snapshots(context),
      typeof binding.config?.maxReadBytes === 'number' ? binding.config.maxReadBytes : undefined,
    ),
  );
  catalog.register('glob', '1', (_binding, context) => createGlobTool(context.runtime));
  catalog.register('grep', '1', (_binding, context) => createGrepTool(context.runtime));
  catalog.register('write_file', '1', (_binding, context) =>
    createWriteFileTool(context.runtime, snapshots(context)),
  );
  catalog.register('edit_file', '1', (_binding, context) =>
    createEditFileTool(context.runtime, snapshots(context)),
  );
  catalog.register('bash', '1', (_binding, context) => createBashTool(context.runtime));
}

export type DataSourceDocument = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type DataSourceQueryContext = {
  principal: PlatformPrincipal;
  agentId: string;
  prompt: string;
  signal: AbortSignal;
  secrets: PlatformSecretResolver;
};

export interface DataSourceConnector {
  readonly type: string;
  retrieve(
    binding: DataSourceBinding,
    context: DataSourceQueryContext,
  ): Promise<DataSourceDocument[]>;
}

export class TrustedDataSourceCatalog {
  private readonly connectors = new Map<string, DataSourceConnector>();

  register(connector: DataSourceConnector): () => void {
    if (this.connectors.has(connector.type)) {
      throw new Error(`Data source connector already registered: ${connector.type}`);
    }
    this.connectors.set(connector.type, connector);
    return () => this.connectors.delete(connector.type);
  }

  async retrieve(
    bindings: readonly DataSourceBinding[],
    context: DataSourceQueryContext,
  ): Promise<Array<{ source: string; documents: DataSourceDocument[] }>> {
    return Promise.all(
      bindings.map(async (binding) => {
        const connector = this.connectors.get(binding.type);
        if (!connector) throw new Error(`Untrusted data source connector: ${binding.type}`);
        return {
          source: binding.name,
          documents: await connector.retrieve(structuredClone(binding), context),
        };
      }),
    );
  }
}

export class InlineDataSourceConnector implements DataSourceConnector {
  readonly type = 'inline';

  async retrieve(
    binding: DataSourceBinding,
    context: DataSourceQueryContext,
  ): Promise<DataSourceDocument[]> {
    const values = Array.isArray(binding.config.documents) ? binding.config.documents : [];
    const documents = values
      .map((value, index): DataSourceDocument | undefined => {
        if (typeof value === 'string') return { id: String(index), text: value };
        if (!value || typeof value !== 'object') return undefined;
        const record = value as Record<string, unknown>;
        if (typeof record.text !== 'string') return undefined;
        return {
          id: typeof record.id === 'string' ? record.id : String(index),
          text: record.text,
          ...(record.metadata && typeof record.metadata === 'object'
            ? { metadata: record.metadata as Record<string, unknown> }
            : {}),
        };
      })
      .filter((value): value is DataSourceDocument => value !== undefined);
    const queryTerms = new Set(context.prompt.toLowerCase().split(/\W+/).filter(Boolean));
    const limit =
      typeof binding.config.limit === 'number'
        ? Math.max(1, Math.min(100, Math.floor(binding.config.limit)))
        : 10;
    return documents
      .map((document) => ({
        document,
        score: document.text
          .toLowerCase()
          .split(/\W+/)
          .filter((term) => queryTerms.has(term)).length,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ document }) => document);
  }
}

export class MongoCollectionDataSourceConnector implements DataSourceConnector {
  readonly type = 'mongodb-collection';

  constructor(private readonly database: Db) {}

  async retrieve(
    binding: DataSourceBinding,
    context: DataSourceQueryContext,
  ): Promise<DataSourceDocument[]> {
    const collectionName = requiredConfigString(binding.config, 'collection');
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(collectionName) ||
      collectionName.startsWith('system.')
    ) {
      throw new Error('Invalid MongoDB data source collection');
    }
    const textField = optionalConfigString(binding.config, 'textField') ?? 'text';
    const idField = optionalConfigString(binding.config, 'idField') ?? 'id';
    const tenantField = optionalConfigString(binding.config, 'tenantField') ?? 'tenantId';
    for (const field of [textField, idField, tenantField]) validateMongoField(field);
    const configuredFilter =
      binding.config.filter &&
      typeof binding.config.filter === 'object' &&
      !Array.isArray(binding.config.filter)
        ? (structuredClone(binding.config.filter) as Filter<Document>)
        : {};
    assertSafeMongoFilter(configuredFilter);
    const queryMode = binding.config.queryMode === 'text' ? 'text' : 'all';
    const filter: Filter<Document> = {
      ...configuredFilter,
      [tenantField]: context.principal.tenantId,
      ...(queryMode === 'text' ? { $text: { $search: context.prompt } } : {}),
    };
    const limit =
      typeof binding.config.limit === 'number'
        ? Math.max(1, Math.min(100, Math.floor(binding.config.limit)))
        : 10;
    const documents = await this.database
      .collection(collectionName)
      .find(filter)
      .limit(limit)
      .toArray();
    return documents
      .map((document): DataSourceDocument | undefined => {
        const text = document[textField];
        if (typeof text !== 'string') return undefined;
        return {
          id: String(document[idField] ?? document._id),
          text,
          metadata: Object.fromEntries(
            Object.entries(document).filter(([name]) => !['_id', textField].includes(name)),
          ),
        };
      })
      .filter((document): document is DataSourceDocument => document !== undefined);
  }
}

export interface PlatformSecretResolver {
  get(tenantId: string, reference: string): Promise<string | undefined>;
}

export class InMemoryPlatformSecretResolver implements PlatformSecretResolver {
  constructor(
    private readonly tenants: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ) {}

  async get(tenantId: string, reference: string): Promise<string | undefined> {
    return this.tenants[tenantId]?.[reference];
  }
}

export class EnvironmentPlatformSecretResolver implements PlatformSecretResolver {
  constructor(
    private readonly prefix = 'PLATFORM_SECRET_',
    private readonly allowGlobalFallback = false,
  ) {}

  async get(tenantId: string, reference: string): Promise<string | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error('Invalid secret reference');
    const tenant = tenantId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    return (
      process.env[`${this.prefix}${tenant}__${reference}`] ??
      (this.allowGlobalFallback ? process.env[`${this.prefix}${reference}`] : undefined)
    );
  }
}

function catalogKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  return value === undefined ? undefined : new URL(value).toString();
}

function requiredConfigString(config: Record<string, unknown>, name: string): string {
  const value = config[name];
  if (typeof value !== 'string' || !value) throw new Error(`Data source config requires ${name}`);
  return value;
}

function optionalConfigString(config: Record<string, unknown>, name: string): string | undefined {
  const value = config[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw new Error(`Data source config ${name} must be a string`);
  return value;
}

function validateMongoField(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(value) || value.includes('..')) {
    throw new Error(`Invalid MongoDB data source field: ${value}`);
  }
}

function assertSafeMongoFilter(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertSafeMongoFilter(child);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$') || key.includes('.')) {
      throw new Error(`MongoDB data source filter contains unsafe key: ${key}`);
    }
    assertSafeMongoFilter(child);
  }
}
