import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextCapability,
  ContextNeed,
  ContextRuntimeAction,
  ExecutableContextCapability,
  NormalizedIntent,
  RuntimePerformanceProfile,
  RuntimeRetrievalOperation,
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
    performanceProfiles: readonly RuntimePerformanceProfile[];
    minimumComparableSamples: number;
    iteration: number;
  }): ContextRuntimeAction | undefined {
    const base =
      input.need.type === 'CURRENT_EXTERNAL_INFORMATION'
        ? planWebAction(input)
        : input.need.type === 'FILE_INFORMATION'
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
  const nextUrl = successfulSearch?.links?.find((url) => !attemptedUrls.has(url));
  if (nextUrl) {
    const mapped = actionInput(fetchTool, { url: nextUrl, query: intent.normalizedRequest });
    if (!mapped) return undefined;
    return {
      needId: need.id,
      capability: 'WEB_FETCH',
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
  const { need, toolPlan, observations, operations } = input;
  const path = need.inputs.path;
  const referenceOrigin = need.inputs.referenceOrigin;
  const selected = toolForCapability(
    toolPlan,
    'FILE_READ',
    input.performanceProfiles,
    input.minimumComparableSamples,
  );
  if (
    !need.sourceKinds.includes('FILE') ||
    typeof path !== 'string' ||
    referenceOrigin !== 'explicit_user_reference' ||
    !selected
  ) {
    return undefined;
  }
  const alreadySucceeded = observations.some(
    (observation) =>
      observation.capability === 'FILE_READ' &&
      observation.needIds?.includes(need.id) &&
      (observation.outcome === 'success' || observation.outcome === 'partial'),
  );
  if (alreadySucceeded) return undefined;
  const mapped = actionInput(selected, { path });
  if (!mapped) return undefined;
  const previousTools = new Set(operations.map((operation) => operation.toolName));
  return {
    needId: need.id,
    capability: 'FILE_READ',
    toolName: selected.capability.name,
    input: mapped,
    reason: 'Read the explicitly identified workspace file through a registered file capability.',
    strategy: previousTools.size === 0 ? 'initial' : 'alternate_capability',
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
    artifactId: ['artifactId', 'artifact', 'id', 'reference'],
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
