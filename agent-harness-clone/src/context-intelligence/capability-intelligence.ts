import type { ContextIntelligenceConfig } from './config.js';
import type {
  CapabilityResolution,
  CapabilityMetadata,
  ContextCapability,
  ContextNeed,
  NormalizedIntent,
  SelectedCapability,
  ToolPlan,
} from './contracts.js';
import type { Tool, ToolDescriptor } from '../tools/tool.js';
import { clamp, containmentScore, dedupeStrings, lexicalSimilarity, uniqueTerms } from './utils.js';

export interface CapabilityMetadataProvider {
  metadata(tool: Tool): CapabilityMetadata | undefined | Promise<CapabilityMetadata | undefined>;
}

export class CapabilityRegistry {
  private readonly values = new Map<string, CapabilityMetadata>();

  constructor(initial: readonly CapabilityMetadata[] = []) {
    for (const value of initial) this.register(value);
  }

  register(value: CapabilityMetadata): void {
    this.values.set(value.name, structuredClone(value));
  }

  get(name: string): CapabilityMetadata | undefined {
    const value = this.values.get(name);
    return value ? structuredClone(value) : undefined;
  }

  list(): readonly CapabilityMetadata[] {
    return [...this.values.values()].map((value) => structuredClone(value));
  }
}

export class CapabilityIntelligence {
  readonly registry: CapabilityRegistry;

  constructor(
    private readonly config: ContextIntelligenceConfig['capability'],
    initial: readonly CapabilityMetadata[] = [],
    private readonly providers: readonly CapabilityMetadataProvider[] = [],
  ) {
    this.registry = new CapabilityRegistry(initial);
  }

  async catalog(tools: readonly Tool[]): Promise<readonly CapabilityMetadata[]> {
    const output: CapabilityMetadata[] = [];
    for (const tool of tools) {
      let metadata = this.registry.get(tool.name) ?? tool.contextMetadata;
      for (const provider of this.providers) metadata ??= await provider.metadata(tool);
      const resolved = metadata
        ? { ...metadata, provides: metadata.provides ?? inferGenericCapabilities(tool) }
        : inferCapability(tool);
      this.registry.register(resolved);
      output.push(resolved);
    }
    return output;
  }

  async select(
    intent: NormalizedIntent,
    tools: readonly Tool[],
    needs: readonly ContextNeed[] = [],
  ): Promise<ToolPlan> {
    const metadata = await this.catalog(tools);
    const descriptors = new Map(tools.map((tool) => [tool.name, descriptorOf(tool)]));
    const scored = metadata
      .filter((capability) => capability.enabled)
      .map((capability) => scoreCapability(capability, intent, descriptors.get(capability.name)))
      .sort((left, right) => right.score - left.score);
    const resolutions = resolveCapabilities(needs, metadata);
    const resolvedToolNames = resolutions
      .filter((resolution) => resolution.status === 'available')
      .flatMap((resolution) => {
        const need = needs.find((candidate) => candidate.id === resolution.needId);
        return need?.status === 'clarification_required' ? [] : resolution.toolNames;
      });
    const forced = new Set([...this.config.alwaysExpose, ...resolvedToolNames]);
    const evidenceConstrained =
      (intent.operation === 'answer' || intent.operation === 'analyze') &&
      needs.some((need) => need.required && need.evidenceRequirement === 'REQUIRED');
    const candidates = evidenceConstrained
      ? scored.filter((entry) => forced.has(entry.capability.name))
      : scored;
    const accepted = candidates.filter(
      (entry, index) =>
        forced.has(entry.capability.name) ||
        entry.score >= this.config.relevanceThreshold ||
        index < this.config.minimumExposed,
    );
    const required = accepted.filter((entry) => forced.has(entry.capability.name));
    const optional = accepted.filter((entry) => !forced.has(entry.capability.name));
    const optionalLimit = Math.max(0, this.config.maximumExposed - required.length);
    const selected = [...required, ...optional.slice(0, optionalLimit)];
    const names = new Set(selected.map((entry) => entry.capability.name));
    return {
      goal: intent.goal,
      selected,
      excluded: scored
        .filter((entry) => !names.has(entry.capability.name))
        .map((entry) => ({
          name: entry.capability.name,
          reason: entry.capability.enabled
            ? `relevance score ${entry.score.toFixed(3)} below selection`
            : 'disabled',
        })),
      argumentRequirements: Object.fromEntries(
        selected.map((entry) => [
          entry.capability.name,
          requiredArguments(entry.descriptor?.inputSchema),
        ]),
      ),
      resolutions,
    };
  }
}

export function inferCapability(tool: Tool): CapabilityMetadata {
  const text = `${tool.name} ${tool.description} ${JSON.stringify(tool.jsonSchema)}`;
  return {
    id: `tool:${tool.name}`,
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    keywords: uniqueTerms(text).slice(0, 80),
    entityTypes: [],
    operations: inferOperations(tool),
    sourceIds: [],
    authority: tool.kind === 'read' ? 0.65 : 0.5,
    cost: tool.kind === 'network' ? 0.6 : tool.kind === 'execute' ? 0.5 : 0.25,
    latency: tool.kind === 'network' ? 0.7 : tool.kind === 'interactive' ? 0.8 : 0.3,
    preconditions: requiredArguments(tool.jsonSchema),
    effects:
      tool.kind === 'read'
        ? ['reads data']
        : tool.kind === 'write'
          ? ['changes data']
          : tool.kind === 'execute'
            ? ['executes an operation']
            : [],
    limitations: [],
    policyLabels: [tool.kind, ...(tool.destructive ? ['destructive'] : [])],
    enabled: true,
    provides: inferGenericCapabilities(tool),
  };
}

export function inferGenericCapabilities(
  tool: Tool,
): Exclude<ContextCapability, 'WEB_RETRIEVAL'>[] {
  const operations = inferOperations(tool).map((operation) => operation.toLowerCase());
  const properties = Object.keys(
    tool.jsonSchema.properties && typeof tool.jsonSchema.properties === 'object'
      ? (tool.jsonSchema.properties as Record<string, unknown>)
      : {},
  ).map((property) => property.toLowerCase());
  const searchable =
    `${tool.description} ${operations.join(' ')} ${properties.join(' ')}`.toLowerCase();
  const capabilities: Exclude<ContextCapability, 'WEB_RETRIEVAL'>[] = [];

  const external =
    tool.kind === 'network' || /\b(web|internet|online|external|url)\b/.test(searchable);
  if (external && operations.some((operation) => operation.includes('search'))) {
    capabilities.push('WEB_SEARCH');
  }
  if (
    external &&
    (operations.some((operation) => operation.includes('fetch')) || properties.includes('url'))
  ) {
    capabilities.push('WEB_FETCH');
  }
  if (tool.kind === 'read' && properties.includes('path')) capabilities.push('FILE_READ');
  if (
    (tool.kind === 'write' || operations.some((operation) => operation.includes('create'))) &&
    /markdown|\.md\b/.test(searchable)
  ) {
    capabilities.push('MARKDOWN_ARTIFACT_CREATE');
  }
  if (
    (tool.kind === 'write' || operations.some((operation) => operation.includes('create'))) &&
    /\b(document|docx)\b/.test(searchable)
  ) {
    capabilities.push('DOCUMENT_ARTIFACT_CREATE');
  }
  return dedupeStrings(capabilities) as Exclude<ContextCapability, 'WEB_RETRIEVAL'>[];
}

function resolveCapabilities(
  needs: readonly ContextNeed[],
  metadata: readonly CapabilityMetadata[],
): CapabilityResolution[] {
  return needs.map((need) => {
    const requiredCapabilities = expandCapability(need.requiredCapability);
    const toolNames: string[] = [];
    const missing: ContextCapability[] = [];
    for (const capability of requiredCapabilities) {
      const candidates = metadata
        .filter((entry) => entry.enabled && (entry.provides ?? []).includes(capability))
        .sort(
          (left, right) =>
            right.authority - left.authority ||
            left.cost + left.latency - (right.cost + right.latency),
        );
      const selected = candidates[0];
      if (selected) toolNames.push(selected.name);
      else missing.push(capability);
    }
    const available = missing.length === 0;
    return {
      needId: need.id,
      requested: need.requiredCapability,
      requiredCapabilities,
      status: available ? 'available' : 'unavailable',
      // Composite capabilities are atomic at resolution time. Exposing a partial
      // implementation (for example fetch without search) invites unrelated model
      // fallback even though the required retrieval chain cannot run.
      toolNames: available ? dedupeStrings(toolNames) : [],
      reason: available
        ? `Resolved ${need.requiredCapability} through registered runtime capabilities.`
        : `No registered runtime capability provides: ${missing.join(', ')}.`,
    };
  });
}

function expandCapability(capability: ContextCapability): ContextCapability[] {
  return capability === 'WEB_RETRIEVAL' ? ['WEB_SEARCH', 'WEB_FETCH'] : [capability];
}

function inferOperations(tool: Tool): string[] {
  const operations: string[] = [tool.kind];
  const name = tool.name.toLowerCase();
  for (const operation of [
    'read',
    'write',
    'search',
    'fetch',
    'create',
    'edit',
    'delete',
    'list',
    'execute',
    'query',
    'retrieve',
  ]) {
    if (name.includes(operation) || tool.description.toLowerCase().includes(operation))
      operations.push(operation);
  }
  return dedupeStrings(operations);
}

function scoreCapability(
  capability: CapabilityMetadata,
  intent: NormalizedIntent,
  descriptor: ToolDescriptor | undefined,
): SelectedCapability {
  const searchable = [
    capability.name,
    capability.description,
    ...capability.keywords,
    ...capability.entityTypes,
    ...capability.operations,
    ...capability.sourceIds,
    ...(descriptor ? [JSON.stringify(descriptor.inputSchema)] : []),
  ].join(' ');
  const lexical = Math.max(
    containmentScore(intent.normalizedRequest, searchable),
    lexicalSimilarity(intent.normalizedRequest, searchable),
  );
  const operation = operationCompatibility(capability.operations, intent.operation);
  const entities =
    intent.entities.length === 0
      ? 0
      : intent.entities.filter((entity) =>
          searchable.toLowerCase().includes(entity.value.toLowerCase()),
        ).length / intent.entities.length;
  const efficiency = 1 - clamp(capability.cost * 0.55 + capability.latency * 0.45);
  const semanticFit = lexical * 0.65 + operation * 0.2 + entities * 0.15;
  const score = clamp(semanticFit * (0.8 + capability.authority * 0.15 + efficiency * 0.05));
  return {
    capability,
    score,
    reasons: [
      ...(lexical > 0 ? ['request metadata overlap'] : []),
      ...(operation > 0.5 ? ['operation match'] : []),
      ...(entities > 0.5 ? ['entity match'] : []),
      ...(capability.authority >= 0.7 ? ['authoritative capability'] : []),
    ],
    ...(descriptor === undefined ? {} : { descriptor }),
  };
}

function operationCompatibility(
  operations: readonly string[],
  intent: NormalizedIntent['operation'],
): number {
  const values = operations.map((operation) => operation.toLowerCase());
  if (values.some((operation) => operation.includes(intent))) return 1;
  const compatible: Record<NormalizedIntent['operation'], readonly string[]> = {
    answer: ['read', 'search', 'fetch', 'query', 'retrieve'],
    analyze: ['read', 'search', 'fetch', 'query', 'retrieve', 'execute'],
    create: ['create', 'write', 'execute'],
    update: ['update', 'edit', 'write', 'execute'],
    delete: ['delete', 'write', 'execute'],
    execute: ['execute', 'write'],
    unknown: [],
  };
  return values.some((operation) =>
    compatible[intent].some((candidate) => operation.includes(candidate)),
  )
    ? 0.5
    : intent === 'unknown'
      ? 0.1
      : 0;
}

function descriptorOf(tool: Tool): ToolDescriptor {
  return { name: tool.name, description: tool.description, inputSchema: tool.jsonSchema };
}

function requiredArguments(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string')
    : [];
}
