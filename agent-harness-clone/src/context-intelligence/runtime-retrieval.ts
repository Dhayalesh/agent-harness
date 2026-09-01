import type { ContextIntelligenceConfig } from './config.js';
import type {
  AdaptiveRetrievalSummary,
  ContextCapability,
  ContextNeed,
  ContextRuntimeAction,
  ExecutableContextCapability,
  NormalizedIntent,
  QueryPlan,
  RetrievalInputTrace,
  RuntimePerformanceProfile,
  RuntimeRetrievalOperation,
  ResourceRecord,
  RetrievalAdaptationStrategy,
  SelectedCapability,
  ToolObservation,
  ToolPlan,
} from './contracts.js';
import { buildRetrievalRequestCandidates } from './query-intelligence.js';
import { rankRuntimeCandidates } from './runtime-performance.js';
import { dedupeStrings, id, stableHash, uniqueTerms } from './utils.js';

const MAXIMUM_IDENTICAL_TRANSIENT_RETRIES = 1;

/** Plans bounded calls to concrete tools already registered with AgentSession. */
export class RuntimeRetrievalPlanner {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  plan(input: {
    requestId: string;
    intent: NormalizedIntent;
    queryPlan?: QueryPlan;
    needs: readonly ContextNeed[];
    toolPlan: ToolPlan;
    observations: readonly ToolObservation[];
    operations: readonly RuntimeRetrievalOperation[];
    resources?: readonly ResourceRecord[];
    performanceProfiles?: readonly RuntimePerformanceProfile[];
    adaptive?: AdaptiveRetrievalSummary;
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
      if (actions.length >= remainingActions) continue;
      const needOperations = requestOperations.filter((operation) => operation.needId === need.id);
      const adaptiveNeed = input.adaptive?.needs.find(
        (assessment) => assessment.needId === need.id,
      );
      const strategies =
        adaptiveNeed?.recommendedStrategies ??
        (needOperations.length === 0 ? (['INITIAL'] as const) : []);
      const unresolvedConflict =
        need.status === 'satisfied' && adaptiveNeed?.outcome === 'SOURCE_CONFLICT';
      if (need.status !== 'missing' && !unresolvedConflict) continue;
      if (strategies.length === 0 || adaptiveNeed?.terminationReason !== undefined) continue;
      const action = this.planNeed({
        requestId: input.requestId,
        need,
        intent: input.intent,
        ...(input.queryPlan === undefined ? {} : { queryPlan: input.queryPlan }),
        toolPlan: input.toolPlan,
        observations,
        operations: needOperations,
        resources: (input.resources ?? []).filter((resource) => resource.needId === need.id),
        performanceProfiles: input.performanceProfiles ?? [],
        minimumComparableSamples: this.config.p3.minimumComparableSamples,
        iteration: iterations + 1,
        strategies,
        ...(adaptiveNeed?.adaptationReason === undefined
          ? {}
          : { adaptationReason: adaptiveNeed.adaptationReason }),
        capabilityQueryLengths: this.config.query.capabilityQueryLengths,
      });
      if (action) actions.push(action);
    }
    return actions;
  }

  private planNeed(input: PlannerInput): ContextRuntimeAction | undefined {
    const base =
      input.need.type === 'CURRENT_EXTERNAL_INFORMATION'
        ? planWebAction(input)
        : input.need.type === 'FILE_INFORMATION' || input.need.type === 'ARTIFACT_INFORMATION'
          ? planFileAction(input)
          : planGenericReadAction(input);
    if (!base) return undefined;
    const attemptKey = stableHash({ toolName: base.toolName, input: base.input });
    const identical = input.operations.filter((operation) => operation.attemptKey === attemptKey);
    const identicalTransientRetries = identical.filter(
      (operation) => operation.strategy === 'TRANSIENT_RETRY',
    ).length;
    if (
      identical.length > 0 &&
      (base.strategy !== 'TRANSIENT_RETRY' ||
        identicalTransientRetries >= MAXIMUM_IDENTICAL_TRANSIENT_RETRIES)
    ) {
      return undefined;
    }
    const previous = input.operations.at(-1);
    return {
      ...base,
      id: id('context_action'),
      requestId: input.requestId,
      attemptKey,
      iteration: input.iteration,
      priorOperationIds: input.operations.map((operation) => operation.id),
      ...(input.adaptationReason === undefined ? {} : { adaptationReason: input.adaptationReason }),
      ...(previous === undefined ? {} : { previousStrategy: previous.strategy }),
    };
  }
}

type PlannerInput = {
  requestId: string;
  need: ContextNeed;
  intent: NormalizedIntent;
  queryPlan?: QueryPlan;
  toolPlan: ToolPlan;
  observations: readonly ToolObservation[];
  operations: readonly RuntimeRetrievalOperation[];
  resources: readonly ResourceRecord[];
  performanceProfiles: readonly RuntimePerformanceProfile[];
  minimumComparableSamples: number;
  iteration: number;
  strategies: readonly RetrievalAdaptationStrategy[];
  adaptationReason?: string;
  /**
   * Per-capability default maximum query lengths in characters, keyed by generic
   * capability name (e.g. { WEB_SEARCH: 400 }).  Forwarded from the engine config
   * so that retrieval-request construction can apply capability-aware bounds when
   * the tool schema does not declare maxLength and the capability metadata does not
   * set maximumQueryLength.
   */
  capabilityQueryLengths?: Readonly<Record<string, number>>;
};

type SelectedToolInput = {
  tool: SelectedCapability;
  input: Record<string, unknown>;
  retrievalInput?: RetrievalInputTrace;
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
    for (const strategy of strategiesFor(input, ['SOURCE_SWITCH', 'TRANSIENT_RETRY'])) {
      const selected = toolForStrategy(
        toolPlan,
        'WEB_FETCH',
        { url: suppliedUrl, query: intent.normalizedRequest },
        operations,
        input.performanceProfiles,
        input.minimumComparableSamples,
        strategy,
        intent,
        input.queryPlan,
        input.capabilityQueryLengths,
      );
      if (!selected) continue;
      return {
        needId: need.id,
        capability: 'WEB_FETCH',
        phase: 'retrieval',
        toolName: selected.tool.capability.name,
        input: selected.input,
        ...(selected.retrievalInput === undefined
          ? {}
          : { retrievalInput: selected.retrievalInput }),
        reason:
          prior.length === 0
            ? 'Fetch the supplied URL as source evidence.'
            : strategy === 'TRANSIENT_RETRY'
              ? 'Retry the same supplied URL once after a transient capability failure.'
              : 'Use another compatible fetch capability for the supplied URL.',
        strategy,
      };
    }
    return undefined;
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
    ? rankedWebCandidates(successfulSearch.links ?? [], intent).find(
        (url) => !hasCanonicalUrl(attemptedUrls, url),
      )
    : undefined;
  if (nextUrl) {
    for (const strategy of strategiesFor(input, ['ADDITIONAL_EVIDENCE', 'SOURCE_SWITCH'])) {
      const selected = unattemptedTool(
        toolPlan,
        'WEB_FETCH',
        { url: nextUrl, query: intent.normalizedRequest },
        operations,
        input.performanceProfiles,
        input.minimumComparableSamples,
        strategy,
        intent,
        input.queryPlan,
        input.capabilityQueryLengths,
      );
      if (!selected) continue;
      return {
        needId: need.id,
        capability: 'WEB_FETCH',
        phase: 'retrieval',
        toolName: selected.tool.capability.name,
        input: selected.input,
        ...(selected.retrievalInput === undefined
          ? {}
          : { retrievalInput: selected.retrievalInput }),
        reason:
          strategy === 'ADDITIONAL_EVIDENCE'
            ? 'Fetch the highest-ranked unexamined candidate as complementary evidence.'
            : 'Change to the highest-ranked unexamined source candidate.',
        strategy,
      };
    }
    return undefined;
  }

  const searchAttempts = operations.filter((operation) => operation.capability === 'WEB_SEARCH');
  for (const strategy of strategiesFor(input, [
    'RETRIEVAL_BROADEN',
    'RETRIEVAL_NARROW',
    'QUERY_REWRITE',
    'QUERY_EXPANSION',
    'QUERY_DECOMPOSITION',
    'SOURCE_SWITCH',
    'ADDITIONAL_EVIDENCE',
    'TRANSIENT_RETRY',
  ])) {
    const query =
      strategy === 'INITIAL' || strategy === 'SOURCE_SWITCH' || strategy === 'RETRIEVAL_BROADEN'
        ? intent.normalizedRequest
        : refinedQuery(intent.normalizedRequest, searchAttempts.length, searchObservations);
    const maxResults =
      strategy === 'RETRIEVAL_BROADEN' ? Math.min(20, 5 + searchAttempts.length * 5) : 5;
    const selected = toolForStrategy(
      toolPlan,
      'WEB_SEARCH',
      { query, maxResults },
      operations,
      input.performanceProfiles,
      input.minimumComparableSamples,
      strategy,
      intent,
      input.queryPlan,
      input.capabilityQueryLengths,
    );
    if (!selected) continue;
    return {
      needId: need.id,
      capability: 'WEB_SEARCH',
      phase: 'discovery',
      toolName: selected.tool.capability.name,
      input: selected.input,
      ...(selected.retrievalInput === undefined
        ? {}
        : { retrievalInput: selected.retrievalInput }),
      reason:
        strategy === 'INITIAL'
          ? 'Obtain source candidates for the missing external evidence.'
          : strategy === 'RETRIEVAL_BROADEN'
            ? 'Relax the result-count constraint after an empty or missing result.'
            : strategy === 'SOURCE_SWITCH'
              ? 'Use another compatible search capability after the prior result was insufficient.'
              : strategy === 'TRANSIENT_RETRY'
                ? 'Retry the unchanged search once after a transient capability failure.'
                : 'Refine the retrieval request around the unresolved evidence gap.',
      strategy,
    };
  }
  return undefined;
}

function planFileAction(input: PlannerInput): PlannedAction | undefined {
  const { need, toolPlan, observations, resources } = input;
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
      const planned = firstToolForStrategies(input, toolPlan, 'ARTIFACT_READ', generic, [
        'SOURCE_SWITCH',
        'ADDITIONAL_EVIDENCE',
        'TRANSIENT_RETRY',
      ]);
      if (planned) {
        return {
          needId: need.id,
          capability: 'ARTIFACT_READ',
          phase: 'retrieval',
          toolName: planned.selected.tool.capability.name,
          input: planned.selected.input,
          reason: 'Retrieve the explicitly identified artifact by user-supplied artifact ID.',
          strategy: planned.strategy,
        };
      }
    }

    // Priority 2: Exactly one artifact candidate from passive discovery
    if (artifactResource && artifactResource.candidates.length === 1) {
      const candidate = artifactResource.candidates[0];
      if (candidate && candidate.artifactId) {
        const generic = {
          artifactId: candidate.artifactId,
          referenceOrigin:
            candidate.discoveredBy === 'context_offload'
              ? 'context_offload'
              : 'explicit_user_reference',
        };
        const planned = firstToolForStrategies(input, toolPlan, 'ARTIFACT_READ', generic, [
          'ADDITIONAL_EVIDENCE',
          'SOURCE_SWITCH',
          'TRANSIENT_RETRY',
        ]);
        if (planned) {
          return {
            needId: need.id,
            capability: 'ARTIFACT_READ',
            phase: 'retrieval',
            toolName: planned.selected.tool.capability.name,
            input: planned.selected.input,
            reason:
              candidate.discoveredBy === 'context_offload'
                ? 'Retrieve the matching same-session artifact discovered from context offload metadata.'
                : 'Retrieve the matching same-session artifact discovered from canonical metadata.',
            strategy: planned.strategy,
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
    const planned = firstToolForStrategies(input, toolPlan, 'FILE_READ', { path: resolvedPath }, [
      'ADDITIONAL_EVIDENCE',
      'SOURCE_SWITCH',
      'TRANSIENT_RETRY',
    ]);
    if (!planned) return undefined;
    return {
      needId: need.id,
      capability: 'FILE_READ',
      phase: 'retrieval',
      toolName: planned.selected.tool.capability.name,
      input: planned.selected.input,
      reason:
        typeof path === 'string'
          ? 'Read the exact path explicitly supplied by the user.'
          : 'Read the unique workspace path returned by resource discovery.',
      strategy: planned.strategy,
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
  const planned = firstToolForStrategies(input, toolPlan, 'FILE_DISCOVERY', discoveryInput, [
    'SOURCE_SWITCH',
    'TRANSIENT_RETRY',
  ]);
  if (!planned) return undefined;
  return {
    needId: need.id,
    capability: 'FILE_DISCOVERY',
    phase: 'discovery',
    toolName: planned.selected.tool.capability.name,
    input: planned.selected.input,
    reason: 'Discover the actual workspace resource before attempting file retrieval.',
    strategy: planned.strategy,
  };
}

function planGenericReadAction(input: PlannerInput): PlannedAction | undefined {
  const initialCapability = executableCapabilityFor(input.need.requiredCapability);
  if (
    !initialCapability ||
    initialCapability === 'FILE_READ' ||
    initialCapability === 'WEB_SEARCH' ||
    initialCapability === 'WEB_FETCH'
  ) {
    return undefined;
  }
  const capabilities = compatibleCapabilities(input, initialCapability);
  for (const requestedStrategy of input.strategies) {
    const strategy = input.operations.length === 0 ? ('INITIAL' as const) : requestedStrategy;
    const orderedCapabilities =
      strategy === 'SOURCE_SWITCH'
        ? [
            ...capabilities.filter(
              (capability) =>
                !input.operations.some((operation) => operation.capability === capability),
            ),
            ...capabilities,
          ]
        : capabilities;
    for (const capability of orderedCapabilities) {
      const prior = input.operations.filter((operation) => operation.capability === capability);
      const genericInputs = { ...input.need.inputs } as Record<string, unknown>;
      if (strategy === 'RETRIEVAL_BROADEN') {
        genericInputs.maxResults = Math.min(100, 20 + input.operations.length * 20);
      }
      if (
        typeof genericInputs.query === 'string' &&
        (strategy === 'RETRIEVAL_NARROW' ||
          strategy === 'QUERY_REWRITE' ||
          strategy === 'ADDITIONAL_EVIDENCE' ||
          strategy === 'QUERY_DECOMPOSITION')
      ) {
        genericInputs.query = refinedGenericQuery(
          genericInputs.query,
          Math.max(1, prior.length),
          input.observations.filter((observation) => observation.needIds?.includes(input.need.id)),
        );
      }
      const selected = toolForStrategy(
        input.toolPlan,
        capability,
        genericInputs,
        input.operations,
        input.performanceProfiles,
        input.minimumComparableSamples,
        strategy,
        input.intent,
        input.queryPlan,
        input.capabilityQueryLengths,
      );
      if (!selected || !isReadOnly(selected.tool)) continue;
      return {
        needId: input.need.id,
        capability,
        phase: 'retrieval',
        toolName: selected.tool.capability.name,
        input: selected.input,
        ...(selected.retrievalInput === undefined
          ? {}
          : { retrievalInput: selected.retrievalInput }),
        reason:
          strategy === 'INITIAL'
            ? `Acquire missing ${input.need.sourceKinds.join('/')} evidence through a registered read capability.`
            : strategy === 'SOURCE_SWITCH'
              ? 'Use another compatible registered source or capability after the prior attempt.'
              : strategy === 'RETRIEVAL_BROADEN'
                ? 'Relax the retrieval result constraint after an empty or missing result.'
                : strategy === 'TRANSIENT_RETRY'
                  ? 'Retry the unchanged operation once after a transient failure.'
                  : 'Change the retrieval request around the unresolved evidence gap.',
        strategy,
      };
    }
  }
  return undefined;
}

function executableCapabilityFor(
  capability: ContextCapability,
): ExecutableContextCapability | undefined {
  return capability === 'WEB_RETRIEVAL' ? undefined : capability;
}

function strategiesFor(
  input: PlannerInput,
  supported: readonly RetrievalAdaptationStrategy[],
): RetrievalAdaptationStrategy[] {
  if (input.operations.length === 0 && input.strategies.includes('INITIAL')) return ['INITIAL'];
  return input.strategies.filter((strategy) => supported.includes(strategy));
}

function compatibleCapabilities(
  input: PlannerInput,
  initial: ExecutableContextCapability,
): ExecutableContextCapability[] {
  const resolution = input.toolPlan.resolutions.find(
    (candidate) => candidate.needId === input.need.id,
  );
  const declared = resolution?.permittedCapabilities ?? resolution?.requiredCapabilities ?? [];
  return [
    ...new Set<ExecutableContextCapability>([
      initial,
      ...declared.filter(
        (capability): capability is ExecutableContextCapability => capability !== 'WEB_RETRIEVAL',
      ),
    ]),
  ];
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
  return rankRuntimeCandidates(ordered, capability, performanceProfiles, minimumComparableSamples)
    .candidates[0];
}

function unattemptedTool(
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  genericInput: Readonly<Record<string, unknown>>,
  operations: readonly RuntimeRetrievalOperation[],
  performanceProfiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
  strategy: RetrievalAdaptationStrategy,
  intent: NormalizedIntent,
  queryPlan?: QueryPlan,
  capabilityQueryLengths?: Readonly<Record<string, number>>,
): SelectedToolInput | undefined {
  const candidates = toolsForCapability(
    toolPlan,
    capability,
    performanceProfiles,
    minimumComparableSamples,
  );
  for (const tool of candidates) {
    const mapped = actionInput(tool, genericInput, {
      intent,
      strategy,
      operations,
      ...(queryPlan === undefined ? {} : { queryPlan }),
      ...(capabilityQueryLengths === undefined ? {} : { capabilityQueryLengths }),
    });
    if (!mapped) continue;
    const attemptKey = stableHash({ toolName: tool.capability.name, input: mapped.input });
    if (operations.some((operation) => operation.attemptKey === attemptKey)) continue;
    return { tool, ...mapped };
  }
  return undefined;
}

function toolForStrategy(
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  genericInput: Readonly<Record<string, unknown>>,
  operations: readonly RuntimeRetrievalOperation[],
  performanceProfiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
  strategy: RetrievalAdaptationStrategy,
  intent: NormalizedIntent,
  queryPlan?: QueryPlan,
  capabilityQueryLengths?: Readonly<Record<string, number>>,
): SelectedToolInput | undefined {
  if (strategy !== 'TRANSIENT_RETRY') {
    return unattemptedTool(
      toolPlan,
      capability,
      genericInput,
      operations,
      performanceProfiles,
      minimumComparableSamples,
      strategy,
      intent,
      queryPlan,
      capabilityQueryLengths,
    );
  }
  const prior = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.capability === capability &&
        operation.strategy !== 'TRANSIENT_RETRY' &&
        (operation.failureClassification === 'timeout' ||
          operation.failureClassification === 'network' ||
          operation.failureClassification === 'rate_limited'),
    );
  if (!prior) return undefined;
  const tool = toolPlan.selected.find(
    (candidate) =>
      candidate.capability.name === prior.toolName &&
      candidate.capability.provides?.includes(capability),
  );
  if (!tool || !isReadOnly(tool)) return undefined;
  return {
    tool,
    input: { ...prior.input },
    ...(prior.retrievalInput === undefined
      ? {}
      : { retrievalInput: structuredClone(prior.retrievalInput) }),
  };
}

function firstToolForStrategies(
  input: PlannerInput,
  toolPlan: ToolPlan,
  capability: ExecutableContextCapability,
  genericInput: Readonly<Record<string, unknown>>,
  supported: readonly RetrievalAdaptationStrategy[],
):
  | {
      strategy: RetrievalAdaptationStrategy;
      selected: SelectedToolInput;
    }
  | undefined {
  for (const strategy of strategiesFor(input, supported)) {
    const selected = toolForStrategy(
      toolPlan,
      capability,
      genericInput,
      input.operations,
      input.performanceProfiles,
      input.minimumComparableSamples,
      strategy,
      input.intent,
      input.queryPlan,
      input.capabilityQueryLengths,
    );
    if (selected) return { strategy, selected };
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
    ...rankRuntimeCandidates(ordered, capability, performanceProfiles, minimumComparableSamples)
      .candidates,
  ];
}

function isReadOnly(selected: SelectedCapability): boolean {
  if (selected.capability.policyLabels.includes('destructive')) return false;
  if (
    selected.capability.effects.some((effect) =>
      /\b(change|write|delete|create|execute)\b/i.test(effect),
    )
  )
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
  context: {
    intent: NormalizedIntent;
    strategy: RetrievalAdaptationStrategy;
    operations: readonly RuntimeRetrievalOperation[];
    queryPlan?: QueryPlan;
    /** Per-capability default query length limits forwarded from engine config. */
    capabilityQueryLengths?: Readonly<Record<string, number>>;
  },
): { input: Record<string, unknown>; retrievalInput?: RetrievalInputTrace } | undefined {
  const schema = selected.descriptor?.inputSchema;
  const propertyDefinitions =
    schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const properties = Object.keys(propertyDefinitions);
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const output: Record<string, unknown> = {};
  let retrievalInput: RetrievalInputTrace | undefined;
  const aliases = selected.capability.inputAliases ?? {};
  for (const [genericName, value] of Object.entries(generic)) {
    if (value === undefined) continue;
    const explicitAlias = aliases[genericName];
    const target = explicitAlias ?? matchingProperty(genericName, properties);
    if (!target && properties.length > 0) continue;
    const argumentName = target ?? genericName;
    const definition = propertyDefinition(propertyDefinitions[argumentName]);
    if (genericName === 'query' && typeof value === 'string') {
      // Resolve maximum query length using three sources in priority order:
      // 1. The tool's own JSON schema maxLength (most authoritative — declared by the tool)
      // 2. The capability metadata's maximumQueryLength (declared by capability registration)
      // 3. A per-capability config default (deployment-level fallback for runtime tools
      //    whose schema does not carry maxLength constraints)
      const schemaMaxLength = numericConstraint(definition.maxLength);
      const capabilityMaxLength = numericConstraint(selected.capability.maximumQueryLength);
      const firstProvides = selected.capability.provides?.[0];
      const configMaxLength =
        firstProvides !== undefined
          ? numericConstraint(context.capabilityQueryLengths?.[firstProvides])
          : undefined;
      const maximumLength = schemaMaxLength ?? capabilityMaxLength ?? configMaxLength;
      const minimumLength = numericConstraint(definition.minLength);
      const candidates = buildRetrievalRequestCandidates({
        intent: context.intent,
        ...(context.queryPlan === undefined ? {} : { plan: context.queryPlan }),
        requested: value,
        ...(maximumLength === undefined ? {} : { maximumLength }),
        maximumCandidates: 8,
        preferDecomposition: context.strategy === 'QUERY_DECOMPOSITION',
      });
      const priorRequests = new Set(
        context.operations
          .filter((operation) => {
            // Only count prior requests from operations that use the SAME generic capability.
            // Without this, a WEB_SEARCH query would block a WEB_FETCH action that uses the
            // same query text as supplementary context, even though the URL is its primary
            // identifier.  Cross-capability de-duplication is unnecessary here because
            // different capabilities produce different tool arguments and attempt keys.
            const firstProvides = selected.capability.provides?.[0];
            return firstProvides === undefined || operation.capability === firstProvides;
          })
          .flatMap((operation) =>
            operation.retrievalInput?.retrievalRequest
              ? [operation.retrievalInput.retrievalRequest]
              : queryLikeValues(operation.input),
          ),
      );
      const permitsSameRequest =
        context.strategy === 'INITIAL' ||
        context.strategy === 'SOURCE_SWITCH' ||
        context.strategy === 'RETRIEVAL_BROADEN';
      const candidate =
        candidates.find(
          (entry) => permitsSameRequest || !priorRequests.has(entry.query),
        ) ?? (permitsSameRequest ? candidates[0] : undefined);
      if (
        !candidate ||
        (minimumLength !== undefined && candidate.query.length < minimumLength) ||
        (maximumLength !== undefined && candidate.query.length > maximumLength)
      ) {
        return undefined;
      }
      output[argumentName] = candidate.query;
      retrievalInput = {
        informationNeed: candidate.informationNeed,
        retrievalRequest: candidate.query,
        argumentName,
        construction: candidate.construction,
        semanticallyCompacted: candidate.semanticallyCompacted,
        ...(maximumLength === undefined ? {} : { capabilityMaximumLength: maximumLength }),
      };
      continue;
    }
    const normalized = validateCapabilityValue(genericName, value, definition);
    if (!normalized.valid) return undefined;
    output[argumentName] = normalized.value;
  }
  if (required.some((name) => output[name] === undefined)) return undefined;
  return { input: output, ...(retrievalInput === undefined ? {} : { retrievalInput }) };
}

function propertyDefinition(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericConstraint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validateCapabilityValue(
  genericName: string,
  value: unknown,
  definition: Readonly<Record<string, unknown>>,
): { valid: true; value: unknown } | { valid: false } {
  const allowed = Array.isArray(definition.enum) ? definition.enum : undefined;
  if (allowed && !allowed.some((candidate) => Object.is(candidate, value))) return { valid: false };
  if (typeof value === 'string') {
    const minimumLength = numericConstraint(definition.minLength);
    const maximumLength = numericConstraint(definition.maxLength);
    if (minimumLength !== undefined && value.length < minimumLength) return { valid: false };
    if (maximumLength !== undefined && value.length > maximumLength) return { valid: false };
    return { valid: true, value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { valid: false };
    const minimum = numericConstraint(definition.minimum);
    const maximum = numericConstraint(definition.maximum);
    if (genericName === 'maxResults') {
      let bounded = value;
      if (minimum !== undefined) bounded = Math.max(minimum, bounded);
      if (maximum !== undefined) bounded = Math.min(maximum, bounded);
      return {
        valid: true,
        value: definition.type === 'integer' ? Math.floor(bounded) : bounded,
      };
    }
    if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
      return { valid: false };
    }
    if (definition.type === 'integer' && !Number.isInteger(value)) return { valid: false };
    return { valid: true, value };
  }
  if (Array.isArray(value)) {
    const minimumItems = numericConstraint(definition.minItems);
    const maximumItems = numericConstraint(definition.maxItems);
    if (
      (minimumItems !== undefined && value.length < minimumItems) ||
      (maximumItems !== undefined && value.length > maximumItems)
    ) {
      return { valid: false };
    }
  }
  return { valid: true, value };
}

function queryLikeValues(input: Readonly<Record<string, unknown>>): string[] {
  const names = new Set([
    'query',
    'search',
    'searchquery',
    'term',
    'question',
    'text',
    'prompt',
    'filter',
  ]);
  return Object.entries(input).flatMap(([name, value]) =>
    names.has(name.toLowerCase()) && typeof value === 'string' ? [value] : [],
  );
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
        aliases[genericName]?.some(
          (candidate) => candidate.toLowerCase() === property.toLowerCase(),
        ),
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
    const hostMatch =
      hostTerms.filter((term) => terms.has(term)).length / Math.max(1, hostTerms.length);
    const institutional = /\.(?:gov|edu)(?:\.[a-z]{2})?$/i.test(parsed.hostname) ? 0.35 : 0;
    const primaryPath =
      /\/(?:docs?|documentation|developer|reference|releases?|newsroom|press)(?:\/|$)/i.test(
        parsed.pathname,
      )
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
    'authoritative documentation verified facts',
  ];
  return dedupeStrings([
    base,
    strategies[Math.min(attempt, strategies.length - 1)] ?? '',
    ...missingTerms,
  ])
    .join(' ');
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
    .join(' ');
}
