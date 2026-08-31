import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextCapability,
  ContextNeed,
  ContextRuntimeAction,
  NormalizedIntent,
  RuntimeRetrievalOperation,
  ToolObservation,
  ToolPlan,
} from './contracts.js';
import { id } from './utils.js';

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
    elapsedMs: number;
  }): ContextRuntimeAction[] {
    if (!this.config.features.retrieval) return [];
    if (input.elapsedMs >= this.config.budgets.maxLoopMilliseconds) return [];
    const iterations = input.operations.reduce(
      (maximum, operation) => Math.max(maximum, operation.iteration),
      0,
    );
    if (iterations >= this.config.budgets.maxRetrievalIterations) return [];
    const remainingActions = Math.max(
      0,
      Math.min(this.config.budgets.maxToolActions, this.config.budgets.maxRetrievalOperations) -
        input.operations.length,
    );
    if (remainingActions === 0) return [];

    const observations = input.observations.filter(
      (observation) => observation.requestId === input.requestId,
    );
    const actions: ContextRuntimeAction[] = [];
    for (const need of input.needs) {
      if (need.status !== 'missing' || actions.length >= remainingActions) continue;
      const action =
        need.type === 'CURRENT_EXTERNAL_INFORMATION'
          ? planWebAction(
              need,
              input.intent,
              input.toolPlan,
              observations,
              input.operations,
              iterations + 1,
            )
          : need.type === 'FILE_INFORMATION'
            ? planFileAction(need, input.toolPlan, observations, input.operations, iterations + 1)
            : undefined;
      if (action) actions.push({ ...action, requestId: input.requestId });
    }
    return actions;
  }
}

function planWebAction(
  need: ContextNeed,
  intent: NormalizedIntent,
  toolPlan: ToolPlan,
  observations: readonly ToolObservation[],
  operations: readonly RuntimeRetrievalOperation[],
  iteration: number,
): Omit<ContextRuntimeAction, 'requestId'> | undefined {
  if (need.sourceRequirement !== 'external' || need.freshnessRequirement === 'ANY') {
    return undefined;
  }
  const searchTool = toolForCapability(toolPlan, 'WEB_SEARCH');
  const fetchTool = toolForCapability(toolPlan, 'WEB_FETCH');
  if (!fetchTool) return undefined;
  const suppliedUrl = need.inputs.url;
  if (typeof suppliedUrl === 'string') {
    const attempted = operations.some(
      (operation) =>
        operation.needId === need.id &&
        operation.capability === 'WEB_FETCH' &&
        operation.input.url === suppliedUrl,
    );
    if (attempted) return undefined;
    return {
      id: id('context_action'),
      needId: need.id,
      capability: 'WEB_FETCH',
      toolName: fetchTool,
      input: { url: suppliedUrl, prompt: intent.normalizedRequest.slice(0, 2_000) },
      reason: 'Fetch the supplied URL as current source evidence.',
      iteration,
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
      .filter((operation) => operation.needId === need.id && operation.capability === 'WEB_FETCH')
      .map((operation) => operation.input.url)
      .filter((url): url is string => typeof url === 'string'),
  );
  const nextUrl = successfulSearch?.links?.find((url) => !attemptedUrls.has(url));
  if (nextUrl) {
    return {
      id: id('context_action'),
      needId: need.id,
      capability: 'WEB_FETCH',
      toolName: fetchTool,
      input: { url: nextUrl, prompt: intent.normalizedRequest.slice(0, 2_000) },
      reason: 'Fetch the highest-ranked unexamined search result as source evidence.',
      iteration,
    };
  }

  const searchAttempts = operations.filter(
    (operation) => operation.needId === need.id && operation.capability === 'WEB_SEARCH',
  ).length;
  const query =
    searchAttempts === 0
      ? intent.normalizedRequest
      : `${intent.normalizedRequest} authoritative source current evidence`.slice(0, 400);
  return {
    id: id('context_action'),
    needId: need.id,
    capability: 'WEB_SEARCH',
    toolName: searchTool,
    input: { query: query.slice(0, 400), maxResults: 5 },
    reason:
      searchAttempts === 0
        ? 'Obtain current source candidates for the missing external evidence.'
        : 'Refine the search because prior candidates did not close the evidence gap.',
    iteration,
  };
}

function planFileAction(
  need: ContextNeed,
  toolPlan: ToolPlan,
  observations: readonly ToolObservation[],
  operations: readonly RuntimeRetrievalOperation[],
  iteration: number,
): Omit<ContextRuntimeAction, 'requestId'> | undefined {
  const path = need.inputs.path;
  const referenceOrigin = need.inputs.referenceOrigin;
  const toolName = toolForCapability(toolPlan, 'FILE_READ');
  if (
    need.sourceRequirement !== 'workspace' ||
    typeof path !== 'string' ||
    referenceOrigin !== 'explicit_user_reference' ||
    !toolName
  ) {
    return undefined;
  }
  const alreadySucceeded = observations.some(
    (observation) =>
      observation.capability === 'FILE_READ' &&
      observation.needIds?.includes(need.id) &&
      (observation.outcome === 'success' || observation.outcome === 'partial'),
  );
  const alreadyAttempted = operations.some(
    (operation) => operation.needId === need.id && operation.capability === 'FILE_READ',
  );
  if (alreadySucceeded || alreadyAttempted) return undefined;
  return {
    id: id('context_action'),
    needId: need.id,
    capability: 'FILE_READ',
    toolName,
    input: { path },
    reason: 'Read the identified workspace file through the registered file capability.',
    iteration,
  };
}

function toolForCapability(toolPlan: ToolPlan, capability: ContextCapability): string | undefined {
  return toolPlan.selected.find((entry) => entry.capability.provides?.includes(capability))
    ?.capability.name;
}
