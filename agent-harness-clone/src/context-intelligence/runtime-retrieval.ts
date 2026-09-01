import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextCapability,
  ContextNeed,
  ContextRuntimeAction,
  ExecutableContextCapability,
  NormalizedIntent,
  RuntimePerformanceProfile,
  RuntimeRetrievalOperation,
  ResourceRecord,
  SelectedCapability,
  ToolObservation,
  ToolPlan,
} from './contracts.js';
import { rankRuntimeCandidates } from './runtime-performance.js';
import { dedupeStrings, id, stableHash, uniqueTerms } from './utils.js';

/** Plans bounded calls to concrete tools already registered with AgentSession. */
export class RuntimeRetrievalPlanner {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  plan(input: {
    requestId: string;
    intent: NormalizedIntent;
    needs: readonly ContextNeed[];
    toolPlan: ToolPlan;
    observations: readonly ToolObservation[];
    operations: readonly RuntimeRetrievalOperation[];
    resources?: readonly ResourceRecord[];
    performanceProfiles?: readonly RuntimePerformanceProfile[];
    elapsedMs: number;
  }): ContextRuntimeAction[] {
    if (!this.config.features.retrieval) return [];
    if (input.elapsedMs >= this.config.budgets.maxLoopMilliseconds) return [];
    const requestOperations = input.operations.filter(
      (operation) => operation.requestId === input.requestId,
    );
    const iterations = requestOperations.reduce(
      (maximum, operation) => Math.max(maximum, operation.iteration),
      0,
    );
    if (iterations >= this.config.budgets.maxRetrievalIterations) return [];
    const remainingActions = Math.max(
      0,
      Math.min(this.config.budgets.maxToolActions, this.config.budgets.maxRetrievalOperations) -
        requestOperations.length,
    );
    if (remainingActions === 0) return [];

    const observations = input.observations.filter(
      (observation) => observation.requestId === input.requestId,
    );
    const actions: ContextRuntimeAction[] = [];
    for (const need of input.needs) {
      if (need.status !== 'missing' || actions.length >= remainingActions) continue;
      const needOperations = requestOperations.filter((operation) => operation.needId === need.id);
      if (needOperations.some((operation) => operation.status === 'denied')) continue;
      const action = this.planNeed({
        requestId: input.requestId,
        need,
        intent: input.intent,
        toolPlan: input.toolPlan,
        observations,
        operations: needOperations,
        resources: (input.resources ?? []).filter((resource) => resource.needId === need.id),
        performanceProfiles: input.performanceProfiles ?? [],
        minimumComparableSamples: this.config.p3.minimumComparableSamples,
        iteration: iterations + 1,
      });
      if (action) actions.push(action);
    }
    return actions;
  }

  private planNeed(input: {
    requestId: string;
    need: ContextNeed;
    intent: NormalizedIntent;
    toolPlan: ToolPlan;
    observations: readonly ToolObservation[];
    operations: readonly RuntimeRetrievalOperation[];
    resources: readonly ResourceRecord[];
    performanceProfiles: readonly RuntimePerformanceProfile[];
    minimumComparableSamples: number;
    iteration: number;
  }): ContextRuntimeAction | undefined {
    const base =
      input.need.type === 'CURRENT_EXTERNAL_INFORMATION'
        ? planWebAction(input)
        : input.need.type === 'FILE_INFORMATION' || input.need.type === 'ARTIFACT_INFORMATION'
          ? planFileAction(input)
          : planGenericReadAction(input);
    if (!base) return undefined;
    const attemptKey = stableHash({ toolName: base.toolName, input: base.input });
    if (input.operations.some((operation) => operation.attemptKey === attemptKey)) return undefined;
    return {
      ...base,
      id: id('context_action'),
      requestId: input.requestId,
      attemptKey,
      iteration: input.iteration,
      priorOperationIds: input.operations.map((operation) => operation.id),
    };
  }
}

type PlannerInput = {
  requestId: string;
  need: ContextNeed;
  intent: NormalizedIntent;
  toolPlan: ToolPlan;
  observations: readonly ToolObservation[];
  operations: readonly RuntimeRetrievalOperation[];
  resources: readonly ResourceRecord[];
  performanceProfiles: readonly RuntimePerformanceProfile[];
  minimumComparableSamples: number;
  iteration: number;
};

type PlannedAction = Omit<
  ContextRuntimeAction,
  'id' | 'requestId' | 'attemptKey' | 'iteration' | 'priorOperationIds'
>;

function planWebAction(input: PlannerInput): PlannedAction | undefined {
  const { need, intent, toolPlan, observations, operations } = input;
  if (!need.sourceKinds.includes('WEB')) return undefined;
  const searchTool = toolForCapability(
    toolPlan,
    'WEB_SEARCH',
    input.performanceProfiles,
    input.minimumComparableSamples,
  );
  const fetchTool = toolForCapability(
    toolPlan,
    'WEB_FETCH',
    input.performanceProfiles,
    input.minimumComparableSamples,
  );
  if (!fetchTool) return undefined;
  const suppliedUrl = need.inputs.url;
  if (typeof suppliedUrl === 'string') {
    const prior = operations.filter((operation) => operation.capability === 'WEB_FETCH');
    if (prior.some((operation) => operation.input.url === suppliedUrl)) return undefined;
    const mapped = actionInput(fetchTool, { url: suppliedUrl, query: intent.normalizedRequest });
    if (!mapped) return undefined;
    return {
      needId: need.id,
      capability: 'WEB_FETCH',
      phase: 'retrieval',
      toolName: fetchTool.capability.name,
      input: mapped,
      reason: 'Fetch the supplied URL as source evidence.',
      strategy: prior.length === 0 ? 'initial' : 'alternate_source',
    };
  }
  if (!searchTool) return undefined;

  const searchObservations = observations.filter(
    (observation) =>
      observation.capability === 'WEB_SEARCH' && observation.needIds?.includes(need.id),
  );
  const successfulSearch = [...searchObservations]
    .reverse()
    .find((observation) => observation.outcome === 'success' || observation.outcome === 'partial');
  const attemptedUrls = new Set(
    operations
      .filter((operation) => operation.capability === 'WEB_FETCH')
      .map((operation) => operation.input.url)
      .filter((url): url is string => typeof url === 'string'),
  );
  const nextUrl = successfulSearch
    ? rankedWebCandidates(successfulSearch.links ?? [], intent)
        .find((url) => !hasCanonicalUrl(attemptedUrls, url))
    : undefined;
  if (nextUrl) {
    const mapped = actionInput(fetchTool, { url: nextUrl, query: intent.normalizedRequest });
    if (!mapped) return undefined;
    return {
      needId: need.id,
      capability: 'WEB_FETCH',
      phase: 'retrieval',
      toolName: fetchTool.capability.name,
      input: mapped,
      reason: 'Fetch the highest-ranked unexamined search result as source evidence.',
      strategy: 'alternate_source',
    };
  }

  const searchAttempts = operations.filter(
    (operation) => operation.capability === 'WEB_SEARCH',
  );
  const query = refinedQuery(intent.normalizedRequest, searchAttempts.length, searchObservations);
  const mapped = actionInput(searchTool, { query, maxResults: 5 });
  if (!mapped) return undefined;
  return {
    needId: need.id,
    capability: 'WEB_SEARCH',
    phase: 'discovery',
    toolName: searchTool.capability.name,
    input: mapped,
    reason:
      searchAttempts.length === 0
        ? 'Obtain source candidates for the missing external evidence.'
        : 'Change the query because prior candidates did not close the evidence gap.',
    strategy: searchAttempts.length === 0 ? 'initial' : 'refined_query',
  };
}

function planFileAction(input: PlannerInput): PlannedAction | undefined {
  const { need, toolPlan, observations, operations, resources } = input;
  const path = need.inputs.path;
  const reference = need.inputs.reference;
  const referenceKind = need.inputs.referenceKind;
  const referenceOrigin = need.inputs.referenceOrigin;
  if (
    referenceOrigin !== 'explicit_user_reference' ||
    (typeof path !== 'string' && typeof reference !== 'string')
  ) {
    return undefined;
  }
  const alreadySucceeded = observations.some(
    (observation) =>
      (observation.capability === 'FILE_READ' || observation.capability === 'ARTIFACT_READ') &&
      observation.needIds?.includes(need.id) &&
      (observation.outcome === 'success' || observation.outcome === 'partial'),
  );
  if (alreadySucceeded) return undefined;

  // ARTIFACT RETRIEVAL PATH
  if (need.sourceKinds.includes('ARTIFACT')) {
    const explicitArtifactId =
      typeof need.inputs.artifactId === 'string' ? need.inputs.artifactId : undefined;
    const artifactResource = resources.find(
      (resource) => resource.sourceKind === 'ARTIFACT' && resource.state === 'FOUND',
    );

    // Priority 1: Explicit artifactId from user (e.g., artifact://abc123)
    if (explicitArtifactId) {
      const generic = {
        artifactId: explicitArtifactId,
        referenceOrigin: 'explicit_user_reference',
      };
      const selected = unattemptedTool(
        toolPlan,
        'ARTIFACT_READ',
        generic,
        operations,
        input.performanceProfiles,
        input.minimumComparableSamples,
      );
      if (selected) {
        return {
          needId: need.id,
          capability: 'ARTIFACT_READ',
          phase: 'retrieval',
          toolName: selected.tool.capability.name,
          input: selected.input,
          reason: 'Retrieve the explicitly identified artifact by user-supplied artifact ID.',
          strategy: operations.length === 0 ? 'initial' : 'alternate_source',
        };
      }
    }

    // Priority 2: Exactly one artifact candidate from passive discovery
    if (artifactResource && artifactResource.candidates.length === 1) {
      const candidate = artifactResource.candidates[0];
      if (candidate.artifactId) {
        const generic = {
          artifactId: candidate.artifactId,
          referenceOrigin:
            candidate.discoveredBy === 'context_offload'
              ? 'context_offload'
              : 'explicit_user_reference',
        };
        const selected = unattemptedTool(
          toolPlan,
          'ARTIFACT_READ',
          generic,
          operations,
          input.performanceProfiles,
          input.minimumComparableSamples,
        );
        if (selected) {
          return {
            needId: need.id,
            capability: 'ARTIFACT_READ',
            phase: 'retrieval',
            toolName: selected.tool.capability.name,
            input: selected.input,
            reason:
              candidate.discoveredBy === 'context_offload'
                ? 'Retrieve the matching same-session artifact discovered from context offload metadata.'
                : 'Retrieve the matching same-session artifact discovered from canonical metadata.',
            strategy: operations.length === 0 ? 'initial' : 'alternate_source',
          };
        }
      }
    }

    // Priority 3: Multiple candidates - requires clarification
    // Do not create an action; let quality gate convert need.status to clarification_required
    // The ContextNeedIntelligence.assess() method will detect multiple candidates and update status
  }

  const fileResource = resources.find((resource) => resource.sourceKind === 'FILE');
  const discoveredPath =
    (fileResource?.state === 'FOUND' || fileResource?.state === 'RETRIEVAL_FAILED') &&
    fileResource.candidates.length === 1
      ? fileResource.candidates[0]?.path
      : undefined;
  const resolvedPath = typeof path === 'string' ? path : discoveredPath;
  if (need.sourceKinds.includes('FILE') && resolvedPath) {
    const selected = unattemptedTool(
      toolPlan,
      'FILE_READ',
      { path: resolvedPath },
      operations,
      input.performanceProfiles,
      input.minimumComparableSamples,
    );
    if (!selected) return undefined;
    return {
      needId: need.id,
      capability: 'FILE_READ',
      phase: 'retrieval',
      toolName: selected.tool.capability.name,
      input: selected.input,
      reason:
        typeof path === 'string'
          ? 'Read the exact path explicitly supplied by the user.'
          : 'Read the unique workspace path returned by resource discovery.',
      strategy: operations.length === 0 ? 'initial' : 'alternate_capability',
    };
  }

  if (
    !need.sourceKinds.includes('FILE') ||
    referenceKind !== 'name' ||
    typeof reference !== 'string' ||
    fileResource?.state === 'VERIFIED_MISSING' ||
    (fileResource?.state === 'FOUND' && fileResource.candidates.length !== 1)
  ) {
    return undefined;
  }
  const discoveryInput = { pattern: exactFilenamePattern(reference), path: '.', maxResults: 20 };
  const discovery = unattemptedTool(
    toolPlan,
    'FILE_DISCOVERY',
    discoveryInput,
    operations,
    input.performanceProfiles,
    input.minimumComparableSamples,
  );
  if (!discovery) return undefined;
  return {
    needId: need.id,
    capability: 'FILE_DISCOVERY',
    phase: 'discovery',
    toolName: discovery.tool.capability.name,
    input: discovery.input,
    reason: 'Discover the actual workspace resource before attempting file retrieval.',
    strategy: operations.length === 0 ? 'initial' : 'alternate_capability',
  };
}

function planGenericReadAction(input: PlannerInput): PlannedAction | undefined {
  const capability = executableCapabilityFor(input.need.requiredCapability);
  if (!capability || capability === 'FILE_READ' || capability === 'WEB_SEARCH' || capability === 'WEB_FETCH') {
    return undefined;
  }
  const selected = toolForCapability(
    input.toolPlan,
    capability,
    input.performanceProfiles,
    input.minimumComparableSamples,
  );
  if (!selected || !isReadOnly(selected)) return undefined;
  const prior = input.operations.filter((operation) => operation.capability === capability);
  const genericInputs = { ...input.need.inputs } as Record<string, unknown>;
  if (prior.length > 0 && typeof genericInputs.query === 'string') {
    genericInputs.query = refinedGenericQuery(
      genericInputs.query,
      prior.length,
      input.observations.filter((observation) => observation.needIds?.includes(input.need.id)),
    );
  }
  const mapped = actionInput(selected, genericInputs);
  if (!mapped) return undefined;
  const previousTools = new Set(prior.map((operation) => operation.toolName));
  return {
    needId: input.need.id,
    capability,
    phase: 'retrieval',
    toolName: selected.capability.name,
    input: mapped,
    reason:
      prior.length === 0
        ? `Acquire missing ${input.need.sourceKinds.join('/')} evidence through a registered read capability.`
        : 'Use a changed query or alternate registered capability after an insufficient observation.',
    strategy:
      prior.length === 0
        ? 'initial'
        : previousTools.has(selected.capability.name)
          ? 'refined_query'
          : 'alternate_capability',
  };
}

function executableCapabilityFor(
  capability: ContextCapability,
): ExecutableContextCapability | undefined {
  return capability === 'WEB_RETRIEVAL' ? undefined : capability;
}

function toolForCapability(
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  performanceProfiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
): SelectedCapability | undefined {
  const resolutionNames = new Set(
    toolPlan.resolutions
      .filter((resolution) => resolution.requiredCapabilities.includes(capability))
      .flatMap((resolution) => resolution.toolNames),
  );
  const matching = toolPlan.selected.filter((entry) =>
    entry.capability.provides?.includes(capability),
  );
  const ordered = [
    ...matching.filter((entry) => resolutionNames.has(entry.capability.name)),
    ...matching.filter((entry) => !resolutionNames.has(entry.capability.name)),
  ];
  return rankRuntimeCandidates(
    ordered,
    capability,
    performanceProfiles,
    minimumComparableSamples,
  ).candidates[0];
}

function unattemptedTool(
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  genericInput: Readonly<Record<string, unknown>>,
  operations: readonly RuntimeRetrievalOperation[],
  performanceProfiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
): { tool: SelectedCapability; input: Record<string, unknown> } | undefined {
  const candidates = toolsForCapability(
    toolPlan,
    capability,
    performanceProfiles,
    minimumComparableSamples,
  );
  for (const tool of candidates) {
    const mapped = actionInput(tool, genericInput);
    if (!mapped) continue;
    const attemptKey = stableHash({ toolName: tool.capability.name, input: mapped });
    if (operations.some((operation) => operation.attemptKey === attemptKey)) continue;
    return { tool, input: mapped };
  }
  return undefined;
}

function toolsForCapability(
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  performanceProfiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
): SelectedCapability[] {
  const resolutionNames = new Set(
    toolPlan.resolutions
      .filter((resolution) =>
        (resolution.permittedCapabilities ?? resolution.requiredCapabilities).includes(capability),
      )
      .flatMap((resolution) => resolution.toolNames),
  );
  const matching = toolPlan.selected.filter((entry) =>
    entry.capability.provides?.includes(capability),
  );
  const ordered = [
    ...matching.filter((entry) => resolutionNames.has(entry.capability.name)),
    ...matching.filter((entry) => !resolutionNames.has(entry.capability.name)),
  ];
  return [
    ...rankRuntimeCandidates(
      ordered,
      capability,
      performanceProfiles,
      minimumComparableSamples,
    ).candidates,
  ];
}

function isReadOnly(selected: SelectedCapability): boolean {
  if (selected.capability.policyLabels.includes('destructive')) return false;
  if (selected.capability.effects.some((effect) => /\b(change|write|delete|create|execute)\b/i.test(effect)))
    return false;
  return (
    selected.capability.kind === 'read' ||
    selected.capability.kind === 'network' ||
    selected.capability.kind === 'retrieval' ||
    selected.capability.kind === 'memory' ||
    selected.capability.kind === 'model' ||
    selected.capability.operations.some((operation) =>
      /\b(read|get|list|search|fetch|query|retrieve|lookup|recall)\b/i.test(operation),
    )
  );
}

function actionInput(
  selected: SelectedCapability,
  generic: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const schema = selected.descriptor?.inputSchema;
  const properties =
    schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const output: Record<string, unknown> = {};
  const aliases = selected.capability.inputAliases ?? {};
  for (const [genericName, value] of Object.entries(generic)) {
    if (value === undefined) continue;
    const explicitAlias = aliases[genericName];
    const target = explicitAlias ?? matchingProperty(genericName, properties);
    if (target) output[target] = value;
  }
  if (properties.length === 0) {
    for (const [key, value] of Object.entries(generic)) if (value !== undefined) output[key] = value;
  }
  if (required.some((name) => output[name] === undefined)) return undefined;
  return output;
}

function matchingProperty(genericName: string, properties: readonly string[]): string | undefined {
  if (properties.includes(genericName)) return genericName;
  const aliases: Record<string, readonly string[]> = {
    query: ['query', 'search', 'searchQuery', 'term', 'question', 'text', 'prompt', 'filter'],
    url: ['url', 'uri', 'endpoint'],
    path: ['path', 'file', 'filePath', 'filename'],
    pattern: ['pattern', 'glob', 'filePattern', 'searchPattern'],
    artifactId: ['artifactId', 'artifact', 'id', 'reference'],
    referenceOrigin: ['referenceOrigin', 'origin'],
    maxResults: ['maxResults', 'limit', 'count', 'pageSize'],
  };
  return aliases[genericName]?.find((candidate) =>
    properties.some((property) => property.toLowerCase() === candidate.toLowerCase()),
  )
    ? properties.find((property) =>
        aliases[genericName]?.some((candidate) => candidate.toLowerCase() === property.toLowerCase()),
      )
    : undefined;
}

function exactFilenamePattern(reference: string): string {
  const filename = reference.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? reference;
  return `**/${filename.replace(/[?*]/g, '')}`.slice(0, 4_096);
}

function rankedWebCandidates(urls: readonly string[], intent: NormalizedIntent): string[] {
  const terms = new Set(uniqueTerms(intent.normalizedRequest));
  return dedupeCanonicalUrls(urls)
    .map((url, index) => ({ url, score: webAuthorityScore(url, terms) - index * 0.002 }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.url);
}

function webAuthorityScore(url: string, terms: ReadonlySet<string>): number {
  try {
    const parsed = new URL(url);
    const hostTerms = uniqueTerms(parsed.hostname.replace(/^www\./i, '').replaceAll('.', ' '));
    const hostMatch = hostTerms.filter((term) => terms.has(term)).length / Math.max(1, hostTerms.length);
    const institutional = /\.(?:gov|edu)(?:\.[a-z]{2})?$/i.test(parsed.hostname) ? 0.35 : 0;
    const primaryPath = /\/(?:docs?|documentation|developer|reference|releases?|newsroom|press)(?:\/|$)/i.test(parsed.pathname)
      ? 0.15
      : 0;
    const insecure = parsed.protocol === 'https:' ? 0 : 0.1;
    return hostMatch * 0.5 + institutional + primaryPath - insecure;
  } catch {
    return -1;
  }
}

function dedupeCanonicalUrls(urls: readonly string[]): string[] {
  const values = new Map<string, string>();
  for (const url of urls) {
    const canonical = canonicalUrl(url);
    if (canonical && !values.has(canonical)) values.set(canonical, url);
  }
  return [...values.values()];
}

function hasCanonicalUrl(attempted: ReadonlySet<string>, candidate: string): boolean {
  const canonical = canonicalUrl(candidate);
  return [...attempted].some((url) => canonicalUrl(url) === canonical);
}

function canonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return undefined;
  }
}

function refinedQuery(
  base: string,
  attempt: number,
  observations: readonly ToolObservation[],
): string {
  const missingTerms = dedupeStrings(
    observations.flatMap((observation) => uniqueTerms(observation.followUpReason ?? '')),
  ).slice(0, 4);
  const strategies = [
    '',
    'official documentation primary source',
    'current authoritative release notes',
    'vendor documentation verified facts',
  ];
  return dedupeStrings([base, strategies[Math.min(attempt, strategies.length - 1)] ?? '', ...missingTerms])
    .join(' ')
    .slice(0, 400);
}

function refinedGenericQuery(
  base: string,
  attempt: number,
  observations: readonly ToolObservation[],
): string {
  const reasons = observations
    .map((observation) => observation.followUpReason ?? '')
    .flatMap(uniqueTerms)
    .slice(0, 6);
  return dedupeStrings([
    base,
    attempt === 1 ? 'authoritative matching records' : 'specific unresolved evidence',
    ...reasons,
  ])
    .join(' ')
    .slice(0, 1_000);
}
