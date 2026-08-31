import type { ContextIntelligenceConfig } from './config.js';
import type {
  CapabilityResolution,
  CapabilityMetadata,
  ContextCapability,
  ContextNeed,
  ContextSourceKind,
  ExecutableContextCapability,
  NormalizedIntent,
  RuntimePerformanceProfile,
  SelectedCapability,
  ToolPlan,
} from './contracts.js';
import type { Tool, ToolDescriptor } from '../tools/tool.js';
import { rankRuntimeCandidates } from './runtime-performance.js';
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
    private readonly observedPerformanceOptimization = false,
    private readonly minimumComparableSamples = 3,
  ) {
    this.registry = new CapabilityRegistry(initial);
  }

  async catalog(tools: readonly Tool[]): Promise<readonly CapabilityMetadata[]> {
    const output: CapabilityMetadata[] = [];
    for (const tool of tools) {
      let metadata = this.registry.get(tool.name) ?? tool.contextMetadata;
      for (const provider of this.providers) metadata ??= await provider.metadata(tool);
      const provides = metadata?.provides ?? inferGenericCapabilities(tool);
      const resolved = metadata
        ? {
            ...metadata,
            provides,
            sourceKinds: metadata.sourceKinds ?? sourceKindsFor(provides),
          }
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
    options: {
      excludeToolNames?: readonly string[];
      performanceProfiles?: readonly RuntimePerformanceProfile[];
    } = {},
  ): Promise<ToolPlan> {
    const metadata = await this.catalog(tools);
    const excludedTools = new Set(options.excludeToolNames ?? []);
    const descriptors = new Map(tools.map((tool) => [tool.name, descriptorOf(tool)]));
    const usableMetadata = metadata.filter(
      (capability) => capability.enabled && !excludedTools.has(capability.name),
    );
    const scored = usableMetadata
      .map((capability) =>
        scoreCapability(
          capability,
          intent,
          descriptors.get(capability.name),
          !this.observedPerformanceOptimization,
        ),
      )
      .sort((left, right) => right.score - left.score);
    const resolutions = resolveCapabilities(
      needs,
      usableMetadata,
      this.observedPerformanceOptimization,
      options.performanceProfiles ?? [],
      this.minimumComparableSamples,
    );
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
      excluded: [
        ...metadata
          .filter((entry) => excludedTools.has(entry.name))
          .map((entry) => ({
            name: entry.name,
            reason: 'excluded after a non-recoverable or capability-mismatch failure in this request',
          })),
        ...scored
          .filter((entry) => !names.has(entry.capability.name))
          .map((entry) => ({
            name: entry.capability.name,
            reason: `relevance score ${entry.score.toFixed(3)} below selection`,
          })),
      ],
      argumentRequirements: Object.fromEntries(
        selected.map((entry) => [
          entry.capability.name,
          requiredArguments(entry.descriptor?.inputSchema),
        ]),
      ),
      requirements: needs.map((need) => structuredClone(need.capabilityRequirement)),
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
    sourceKinds: sourceKindsFor(inferGenericCapabilities(tool)),
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

export function inferGenericCapabilities(tool: Tool): ExecutableContextCapability[] {
  const operations = inferOperations(tool).map((operation) => operation.toLowerCase());
  const properties = Object.keys(
    tool.jsonSchema.properties && typeof tool.jsonSchema.properties === 'object'
      ? (tool.jsonSchema.properties as Record<string, unknown>)
      : {},
  ).map((property) => property.toLowerCase());
  const searchable =
    `${tool.name} ${tool.description} ${operations.join(' ')} ${properties.join(' ')}`.toLowerCase();
  const capabilities: ExecutableContextCapability[] = [];
  const readLike =
    !tool.destructive &&
    (tool.kind === 'read' ||
      tool.kind === 'network' ||
      operations.some((operation) =>
        ['read', 'get', 'list', 'search', 'fetch', 'query', 'retrieve', 'lookup', 'recall'].some(
          (candidate) => operation.includes(candidate),
        ),
      ));
  const external =
    tool.kind === 'network' || /\b(web|internet|online|external|url|http)\b/.test(searchable);
  if (external && operations.some((operation) => operation.includes('search'))) {
    capabilities.push('WEB_SEARCH');
  }
  if (
    external &&
    !/\b(api|graphql|endpoint|web service)\b/.test(searchable) &&
    (operations.some((operation) => operation.includes('fetch')) || properties.includes('url'))
  ) {
    capabilities.push('WEB_FETCH');
  }
  const fileDiscovery =
    readLike &&
    properties.includes('pattern') &&
    /\b(glob|find files?|list files?|file discovery)\b/.test(searchable);
  if (fileDiscovery) capabilities.push('FILE_DISCOVERY');
  if (tool.kind === 'read' && properties.includes('path') && !fileDiscovery) {
    capabilities.push('FILE_READ');
  }
  if (
    readLike &&
    /\b(database|data warehouse|sql|table|record query|repository query)\b/.test(searchable)
  ) {
    capabilities.push('DATABASE_QUERY');
  }
  if (readLike && /\b(api|graphql|endpoint|web service)\b/.test(searchable)) {
    capabilities.push('API_RETRIEVAL');
  }
  if (readLike && (tool.name.startsWith('mcp__') || /\bmcp\b/.test(searchable))) {
    capabilities.push('MCP_RETRIEVAL');
  }
  if (readLike && /\b(memory|recall|remembered)\b/.test(searchable)) {
    capabilities.push('MEMORY_RECALL');
  }
  if (readLike && /\b(task state|task status|workflow state|pending work)\b/.test(searchable)) {
    capabilities.push('TASK_STATE_READ');
  }
  if (readLike && /\b(artifact|generated document|generated report)\b/.test(searchable)) {
    capabilities.push('ARTIFACT_READ');
  }
  if (
    readLike &&
    /\b(artifact|generated document|generated report)\b/.test(searchable) &&
    operations.some((operation) => operation.includes('search') || operation.includes('list'))
  ) {
    capabilities.push('ARTIFACT_DISCOVERY');
  }
  if (readLike && /\b(application context|project context|workspace context)\b/.test(searchable)) {
    capabilities.push('APPLICATION_CONTEXT_READ');
  }
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
  return dedupeStrings(capabilities) as ExecutableContextCapability[];
}

function resolveCapabilities(
  needs: readonly ContextNeed[],
  metadata: readonly CapabilityMetadata[],
  observedPerformanceOptimization = false,
  performanceProfiles: readonly RuntimePerformanceProfile[] = [],
  minimumComparableSamples = 3,
): CapabilityResolution[] {
  return needs.map((need) => {
    const primaryCapabilities = expandCapability(need.requiredCapability);
    const prerequisiteCapabilities = need.capabilityRequirement.prerequisiteCapabilities ?? [];
    const alternativeCapabilities = need.capabilityRequirement.alternativeCapabilities ?? [];
    const permittedCapabilities = dedupeStrings([
      ...primaryCapabilities,
      ...alternativeCapabilities,
    ]) as ExecutableContextCapability[];
    const alternatives: Partial<Record<ExecutableContextCapability, readonly string[]>> = {};
    let observedSelection = false;
    const candidatesFor = (
      capability: ExecutableContextCapability,
    ): readonly CapabilityMetadata[] => {
      const declaredOrder = metadata
        .filter((entry) => entry.enabled && (entry.provides ?? []).includes(capability))
        .sort((left, right) =>
          observedPerformanceOptimization
            ? right.authority - left.authority
            : right.authority - left.authority ||
              left.cost + left.latency - (right.cost + right.latency),
        );
      const ranking = observedPerformanceOptimization
        ? rankRuntimeCandidates(
            declaredOrder.map((candidate) => ({
              capability: candidate,
              score: 0,
              reasons: [],
            })),
            capability,
            performanceProfiles,
            minimumComparableSamples,
          )
        : {
            candidates: declaredOrder.map((candidate) => ({
              capability: candidate,
              score: 0,
              reasons: [],
            })),
            eligibleProfiles: 0,
            reordered: false,
          };
      const candidates = ranking.candidates.map((entry) => entry.capability);
      if (ranking.reordered) observedSelection = true;
      alternatives[capability] = candidates.map((candidate) => candidate.name);
      return candidates;
    };
    const prerequisiteCandidates = prerequisiteCapabilities.map((capability) => ({
      capability,
      candidates: candidatesFor(capability),
    }));
    const primaryCandidates = primaryCapabilities.map((capability) => ({
      capability,
      candidates: candidatesFor(capability),
    }));
    const alternativeCandidates = alternativeCapabilities.map((capability) => ({
      capability,
      candidates: candidatesFor(capability),
    }));
    const prerequisitesAvailable = prerequisiteCandidates.every(
      (entry) => entry.candidates.length > 0,
    );
    const primaryAvailable = primaryCandidates.every((entry) => entry.candidates.length > 0);
    const primaryRouteAvailable = prerequisitesAvailable && primaryAvailable;
    const selectedAlternative = primaryRouteAvailable
      ? undefined
      : alternativeCandidates.find((entry) => entry.candidates.length > 0);
    const available = primaryRouteAvailable || selectedAlternative !== undefined;
    const selectedAcquisitionCapabilities = primaryRouteAvailable
      ? primaryCapabilities
      : selectedAlternative
        ? [selectedAlternative.capability]
        : [];
    const requiredCapabilities = dedupeStrings([
      ...(primaryRouteAvailable ? prerequisiteCapabilities : []),
      ...selectedAcquisitionCapabilities,
    ]) as ExecutableContextCapability[];
    const toolNames = dedupeStrings([
      ...prerequisiteCandidates.flatMap((entry) =>
        entry.candidates.slice(0, 1).map((candidate) => candidate.name),
      ),
      ...primaryCandidates.flatMap((entry) => entry.candidates.map((candidate) => candidate.name)),
      ...alternativeCandidates.flatMap((entry) =>
        entry.candidates.map((candidate) => candidate.name),
      ),
    ]);
    const missing = dedupeStrings([
      ...prerequisiteCandidates
        .filter((entry) => entry.candidates.length === 0)
        .map((entry) => entry.capability),
      ...(!available ? [...primaryCapabilities, ...alternativeCapabilities] : []),
    ]);
    return {
      needId: need.id,
      requested: need.requiredCapability,
      requiredCapabilities,
      permittedCapabilities,
      status: available ? 'available' : 'unavailable',
      // A primary route is atomic with its prerequisites. A declared alternative
      // is an independent source-compatible route, never an unrelated fallback.
      toolNames: available ? toolNames : [],
      alternatives,
      selectionBasis: observedSelection ? 'observed_performance' : 'declared_order',
      reason: available
        ? observedSelection
          ? `Resolved ${need.requiredCapability} through registered runtime capabilities using comparable observed performance.`
          : `Resolved ${need.requiredCapability} through registered runtime capabilities.`
        : `No registered runtime capability provides: ${missing.join(', ')}.`,
    };
  });
}

function expandCapability(capability: ContextCapability): ExecutableContextCapability[] {
  return capability === 'WEB_RETRIEVAL' ? ['WEB_SEARCH', 'WEB_FETCH'] : [capability];
}

function sourceKindsFor(capabilities: readonly ContextCapability[]): ContextSourceKind[] {
  const kinds: ContextSourceKind[] = [];
  for (const capability of capabilities) {
    if (capability === 'WEB_SEARCH' || capability === 'WEB_FETCH') kinds.push('WEB');
    else if (capability === 'FILE_DISCOVERY' || capability === 'FILE_READ') kinds.push('FILE');
    else if (capability === 'DATABASE_QUERY') kinds.push('DATABASE');
    else if (capability === 'API_RETRIEVAL') kinds.push('API');
    else if (capability === 'MCP_RETRIEVAL') kinds.push('MCP');
    else if (capability === 'MEMORY_RECALL') kinds.push('MEMORY');
    else if (capability === 'TASK_STATE_READ') kinds.push('TASK_STATE');
    else if (
      capability === 'ARTIFACT_DISCOVERY' ||
      capability === 'ARTIFACT_READ' ||
      capability === 'MARKDOWN_ARTIFACT_CREATE' ||
      capability === 'DOCUMENT_ARTIFACT_CREATE'
    )
      kinds.push('ARTIFACT');
    else if (capability === 'APPLICATION_CONTEXT_READ') kinds.push('APPLICATION_CONTEXT');
  }
  return dedupeStrings(kinds) as ContextSourceKind[];
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
  useDeclaredPerformance = true,
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
  const efficiencyContribution = useDeclaredPerformance ? efficiency * 0.05 : 0.05;
  const score = clamp(
    semanticFit * (0.8 + capability.authority * 0.15 + efficiencyContribution),
  );
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
