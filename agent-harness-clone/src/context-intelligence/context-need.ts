import type {
  CapabilityResolution,
  ContextCapability,
  ContextFreshnessRequirement,
  ContextNeed,
  ContextNeedType,
  ContextScope,
  ContextSourceKind,
  EvidenceItem,
  NormalizedIntent,
} from './contracts.js';
import { dedupeStrings, id } from './utils.js';

/** Identifies concrete information gaps before retrieval or tool selection occurs. */
export class ContextNeedIntelligence {
  identify(
    intent: NormalizedIntent,
    scope: ContextScope,
    requestId = id('request'),
  ): ContextNeed[] {
    const needs: ContextNeed[] = [];
    const request = intent.originalRequest;
    const informationRequest =
      intent.instructionSegments.userIntent || intent.normalizedRequest || intent.goal;
    const suppliedUrl = intent.entities
      .find((entity) => entity.type === 'uri')
      ?.value.replace(/[),.;]+$/, '');
    const explicitSource = explicitGenericSource(informationRequest);

    if (requiresCurrentExternalInformation(intent, informationRequest, explicitSource)) {
      const capability = suppliedUrl ? 'WEB_FETCH' : 'WEB_RETRIEVAL';
      needs.push(
        createNeed({
          requestId,
          type: 'CURRENT_EXTERNAL_INFORMATION',
          requiredInformation: ['current externally observable state'],
          missingInformation: ['current external evidence'],
          reason: 'The request depends on externally observable information or information that can change after model training.',
          sourceRequirement: 'external',
          sourceKinds: ['WEB'],
          freshnessRequirement: currentExternalFreshnessRequirement(intent),
          authorityRequirement: authorityRequirement(informationRequest),
          evidenceRequirement: 'REQUIRED',
          requiredCapability: capability,
          priority: 'critical',
          scope,
          inputs: {
            query: intent.normalizedRequest,
            ...(suppliedUrl === undefined ? {} : { url: suppliedUrl }),
          },
        }),
      );
    }

    const fileReference = extractFileReference(request);
    const requiresFileContent = explicitlyRequiresFileContent(informationRequest) && !suppliedUrl;
    if ((fileReference && intent.operation !== 'create') || requiresFileContent) {
      needs.push(
        createNeed({
          requestId,
          type: 'FILE_INFORMATION',
          requiredInformation: ['workspace file contents'],
          missingInformation: [fileReference ? 'file evidence' : 'file path'],
          reason: fileReference
            ? 'The requested answer depends on the contents of a user-identified workspace file.'
            : 'The request asks for file contents but does not identify the file to read.',
          sourceRequirement: 'workspace',
          sourceKinds: ['FILE'],
          freshnessRequirement: freshnessRequirement(intent),
          authorityRequirement: 'AUTHORITATIVE',
          evidenceRequirement: 'REQUIRED',
          requiredCapability: 'FILE_READ',
          priority: 'high',
          scope,
          status: fileReference ? 'missing' : 'clarification_required',
          inputs: fileReference
            ? { path: fileReference.path, referenceOrigin: fileReference.origin }
            : {},
        }),
      );
    }

    const genericNeed = identifyGenericSourceNeed(intent, scope, requestId, explicitSource, suppliedUrl);
    if (genericNeed) needs.push(genericNeed);

    if (
      intent.operation === 'create' &&
      /(?:\b(?:markdown|document|report|artifact)\b|\.md\b)/i.test(
        `${informationRequest} ${intent.requestedOutput ?? ''}`,
      )
    ) {
      const markdown = /(?:\bmarkdown\b|\.md\b)/i.test(
        `${informationRequest} ${intent.requestedOutput ?? ''}`,
      );
      needs.push(
        createNeed({
          requestId,
          type: 'DOCUMENT_CREATION',
          requiredInformation: ['requested document output capability'],
          missingInformation: ['runtime document creation capability'],
          reason: 'The requested deliverable must be created through an available runtime capability.',
          sourceRequirement: 'any',
          sourceKinds: ['ARTIFACT'],
          freshnessRequirement: 'NONE',
          authorityRequirement: 'ANY',
          evidenceRequirement: 'NONE',
          requiredCapability: markdown ? 'MARKDOWN_ARTIFACT_CREATE' : 'DOCUMENT_ARTIFACT_CREATE',
          priority: 'high',
          scope,
          inputs: {},
          readOnly: false,
        }),
      );
    }

    return dedupeNeeds(needs);
  }

  assess(
    needs: readonly ContextNeed[],
    evidence: readonly EvidenceItem[],
    resolutions: readonly CapabilityResolution[],
    availableSourceKinds: readonly ContextSourceKind[] = [],
  ): ContextNeed[] {
    return needs.map((need) => {
      if (need.status === 'clarification_required') return need;
      const resolution = resolutions.find((entry) => entry.needId === need.id);
      if (
        need.evidenceRequirement !== 'NONE' &&
        needSatisfied(need, evidence, resolution, availableSourceKinds)
      ) {
        return { ...need, status: 'satisfied' as const, missingInformation: [] };
      }
      if (need.evidenceRequirement === 'NONE' && resolution?.status === 'available') {
        return { ...need, status: 'satisfied' as const, missingInformation: [] };
      }
      if (!resolution || resolution.status === 'unavailable') {
        return {
          ...need,
          status: 'unavailable' as const,
          missingInformation: dedupeStrings([
            ...need.missingInformation,
            `${need.requiredCapability} capability unavailable`,
          ]),
          reason: `${need.reason} ${resolution?.reason ?? 'No runtime capability resolution was produced.'}`,
        };
      }
      return {
        ...need,
        status: 'missing' as const,
      };
    });
  }
}

type NeedInput = {
  requestId: string;
  type: ContextNeedType;
  requiredInformation: readonly string[];
  missingInformation: readonly string[];
  reason: string;
  sourceRequirement: ContextNeed['sourceRequirement'];
  sourceKinds: readonly ContextSourceKind[];
  freshnessRequirement: ContextFreshnessRequirement;
  authorityRequirement: ContextNeed['authorityRequirement'];
  evidenceRequirement: ContextNeed['evidenceRequirement'];
  requiredCapability: ContextCapability;
  priority: ContextNeed['priority'];
  scope: ContextScope;
  inputs: Readonly<Record<string, unknown>>;
  status?: ContextNeed['status'];
  readOnly?: boolean;
};

function createNeed(input: NeedInput): ContextNeed {
  const needId = `${input.requestId}:${input.type}`;
  return {
    id: needId,
    type: input.type,
    required: true,
    requiredInformation: input.requiredInformation,
    missingInformation: input.missingInformation,
    reason: input.reason,
    sourceRequirement: input.sourceRequirement,
    sourceKinds: input.sourceKinds,
    freshnessRequirement: input.freshnessRequirement,
    authorityRequirement: input.authorityRequirement,
    scope: structuredClone(input.scope),
    evidenceRequirement: input.evidenceRequirement,
    requiredCapability: input.requiredCapability,
    capabilityRequirement: {
      id: `${needId}:capability`,
      needId,
      capability: input.requiredCapability,
      sourceKinds: input.sourceKinds,
      readOnly: input.readOnly ?? true,
      requiredInputs: Object.keys(input.inputs),
      authorityRequirement: input.authorityRequirement,
      freshnessRequirement: input.freshnessRequirement,
    },
    priority: input.priority,
    status: input.status ?? 'missing',
    inputs: input.inputs,
  };
}

function identifyGenericSourceNeed(
  intent: NormalizedIntent,
  scope: ContextScope,
  requestId: string,
  source: ContextSourceKind | undefined,
  suppliedUrl: string | undefined,
): ContextNeed | undefined {
  if (!source || source === 'WEB' || source === 'FILE' || intent.operation === 'create') {
    return undefined;
  }
  const common = {
    requestId,
    requiredInformation: [intent.normalizedRequest || 'requested source information'],
    missingInformation: [`${source.toLowerCase().replace('_', ' ')} evidence`],
    freshnessRequirement: freshnessRequirement(intent),
    authorityRequirement: authorityRequirement(intent.instructionSegments.userIntent),
    evidenceRequirement: 'REQUIRED' as const,
    priority: 'high' as const,
    scope,
  };
  switch (source) {
    case 'DATABASE':
      return createNeed({
        ...common,
        type: 'DATABASE_INFORMATION',
        reason: 'The request explicitly depends on a database or system-of-record query.',
        sourceRequirement: 'database',
        sourceKinds: ['DATABASE'],
        requiredCapability: 'DATABASE_QUERY',
        inputs: { query: intent.normalizedRequest },
      });
    case 'API':
      return createNeed({
        ...common,
        type: 'API_INFORMATION',
        reason: 'The request explicitly depends on information exposed by an API.',
        sourceRequirement: 'api',
        sourceKinds: ['API'],
        requiredCapability: 'API_RETRIEVAL',
        inputs: {
          query: intent.normalizedRequest,
          ...(suppliedUrl === undefined ? {} : { url: suppliedUrl }),
        },
      });
    case 'MCP':
      return createNeed({
        ...common,
        type: 'MCP_DOMAIN_INFORMATION',
        reason: 'The request explicitly names an MCP-provided domain source.',
        sourceRequirement: 'mcp',
        sourceKinds: ['MCP'],
        requiredCapability: 'MCP_RETRIEVAL',
        inputs: { query: intent.normalizedRequest },
      });
    case 'MEMORY':
      return createNeed({
        ...common,
        type: 'MEMORY_INFORMATION',
        reason: 'The request explicitly depends on governed memory from prior work.',
        sourceRequirement: 'memory',
        sourceKinds: ['MEMORY'],
        requiredCapability: 'MEMORY_RECALL',
        inputs: { query: intent.normalizedRequest },
      });
    case 'TASK_STATE':
      return createNeed({
        ...common,
        type: 'TASK_STATE_INFORMATION',
        reason: 'The request explicitly asks for current structured task state.',
        sourceRequirement: 'task-state',
        sourceKinds: ['TASK_STATE'],
        requiredCapability: 'TASK_STATE_READ',
        inputs: {},
      });
    case 'ARTIFACT': {
      const artifactId = extractArtifactReference(intent.originalRequest);
      return createNeed({
        ...common,
        type: 'ARTIFACT_INFORMATION',
        reason: artifactId
          ? 'The request explicitly references a generated artifact.'
          : 'The request references an artifact but does not identify it.',
        sourceRequirement: 'artifact',
        sourceKinds: ['ARTIFACT'],
        requiredCapability: 'ARTIFACT_READ',
        inputs: artifactId ? { artifactId, referenceOrigin: 'explicit_user_reference' } : {},
        status: artifactId ? 'missing' : 'clarification_required',
      });
    }
    case 'APPLICATION_CONTEXT':
      return createNeed({
        ...common,
        type: 'APPLICATION_CONTEXT_INFORMATION',
        reason: 'The request explicitly depends on application-provided context.',
        sourceRequirement: 'application-context',
        sourceKinds: ['APPLICATION_CONTEXT'],
        requiredCapability: 'APPLICATION_CONTEXT_READ',
        inputs: {},
      });
    default:
      return undefined;
  }
}

function explicitGenericSource(request: string): ContextSourceKind | undefined {
  if (/\b(?:database|data\s*base|data warehouse|warehouse|sql|table|system of record)\b/i.test(request))
    return 'DATABASE';
  if (/\b(?:mcp|model context protocol)(?:\s+(?:server|tool|resource|source))?\b/i.test(request))
    return 'MCP';
  if (/\b(?:api|rest|graphql|endpoint|web service)\b/i.test(request)) return 'API';
  if (/\b(?:from (?:your |the )?memory|remember what|previously (?:said|stored|learned)|my saved preference)\b/i.test(request))
    return 'MEMORY';
  if (/\b(?:task state|task status|pending work|completed work|next action|unresolved questions?)\b/i.test(request))
    return 'TASK_STATE';
  if (/\b(?:artifact|generated report|generated document)\b/i.test(request)) return 'ARTIFACT';
  if (/\b(?:application context|project context|workspace context)\b/i.test(request))
    return 'APPLICATION_CONTEXT';
  if (/\b(?:file|path|attachment|workspace file)\b/i.test(request)) return 'FILE';
  if (/\b(?:web|internet|online|website|url)\b/i.test(request)) return 'WEB';
  return undefined;
}

function requiresCurrentExternalInformation(
  intent: NormalizedIntent,
  request: string,
  explicitSource: ContextSourceKind | undefined,
): boolean {
  if (explicitSource && explicitSource !== 'WEB') return false;
  const hasExternalUri = intent.entities.some((entity) => entity.type === 'uri');
  const stronglyExternal =
    /\b(web|internet|online|external|official (?:information|sources?)|news|weather|stock|share price|exchange rate|current president|current ceo|latest release|latest version|today'?s|search online)\b/i.test(
      request,
    );
  const evidenceRequested = /\b(sources?|evidence|verify|look up)\b/i.test(request);
  const explicitlyLocal = Boolean(extractFileReference(intent.originalRequest));
  return (
    hasExternalUri ||
    stronglyExternal ||
    (evidenceRequested && !explicitlyLocal) ||
    Boolean(intent.temporal?.requiresCurrentData && !explicitlyLocal)
  );
}

function explicitlyRequiresFileContent(request: string): boolean {
  return (
    /\b(read|open|inspect|review|summari[sz]e|use|find|extract|get)\b.{0,60}\b(?:(?:this|that|the|attached|uploaded|created|generated|local|workspace|source)\s+)?(?:file|attachment)\b/i.test(
      request,
    ) ||
    /\b(?:read|open|inspect|review|summari[sz]e|use|find|extract|get|in|from|inside|within)\b.{0,60}\b(?:this|that|the|created|generated|attached|uploaded|local|workspace|source)\s+(?:artifact|document)\b/i.test(
      request,
    ) ||
    /\b(?:read|open|inspect|review|summari[sz]e|use|extract|get)\b.{0,60}\b(?:the\s+)?(?:created|generated|attached|uploaded|local|workspace|source)\s+report\b/i.test(
      request,
    )
  );
}

type ExplicitFileReference = {
  path: string;
  origin: 'explicit_user_reference';
};

/**
 * Extracts only literal user-supplied file references. Freshness words are never
 * converted into paths, and prose containing slash-separated alternatives is not
 * treated as a workspace location unless the request gives it file/path semantics.
 */
function extractFileReference(request: string): ExplicitFileReference | undefined {
  const directive = stripAttachedContent(request).replace(/\b[A-Za-z]+:\/\/\S+/g, ' ');
  const candidates = dedupeStrings([
    ...(directive.match(/`([^`\r\n]+)`/g) ?? []).map((value) => value.slice(1, -1).trim()),
    ...(directive.match(
      /(?<![A-Za-z0-9_\\/])(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s"'<>|?*]+/g,
    ) ?? []),
    ...(
      directive.match(
        /(?:^|\s)([\w.-]+(?:[\\/][\w .-]+)*\.[A-Za-z0-9]{1,12})(?=\s|$|[,.):;"'])/g,
      ) ?? []
    ).map((value) => value.trim()),
  ]);
  for (const candidate of candidates) {
    if (!isConcreteFileReference(candidate, directive)) continue;
    return { path: candidate, origin: 'explicit_user_reference' };
  }
  return undefined;
}

function isConcreteFileReference(candidate: string, request: string): boolean {
  if (!candidate || candidate.length > 4_096 || /[\r\n]/.test(candidate)) return false;
  const escaped = escapeRegExp(candidate);
  const quoted = new RegExp('`' + escaped + '`').test(request);
  const fileLike = /\.[A-Za-z0-9]{1,12}$/.test(candidate);
  const explicitlyRelative = /^\.\.?[\\/]/.test(candidate);
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(candidate);
  const unixAbsolute = /^\//.test(candidate);
  if (fileLike || explicitlyRelative || windowsAbsolute || unixAbsolute) return true;
  const referenceCue = new RegExp(
    `(?:\\b(?:file|path|attachment|artifact|document|report)\\b.{0,40}${escaped}|${escaped}.{0,40}\\b(?:file|path|attachment|artifact|document|report)\\b)`,
    'i',
  );
  const quotedReadTarget =
    quoted &&
    !/[\\/]/.test(candidate) &&
    new RegExp(`\\b(?:read|open|inspect|review|summari[sz]e|use|extract|get)\\b.{0,40}${escaped}`, 'i').test(
      request,
    );
  return referenceCue.test(request) || quotedReadTarget;
}

function extractArtifactReference(request: string): string | undefined {
  return request.match(/\bartifact(?:\s+(?:id|reference))?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_.:-]{2,200})\b/i)?.[1];
}

function stripAttachedContent(request: string): string {
  return request.replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function freshnessRequirement(intent: NormalizedIntent): ContextFreshnessRequirement {
  const expression = intent.temporal?.expression ?? '';
  if (/\b(?:historical|history|as of|in \d{4}|between)\b/i.test(expression)) return 'HISTORICAL';
  if (/\btoday\b/i.test(expression)) return 'TODAY';
  if (/\bthis\s+week\b/i.test(expression)) return 'THIS_WEEK';
  if (/\blatest|newest\b/i.test(expression)) return 'LATEST';
  if (/\brecent(?:ly|\s+changes?)?|last\s+\d+\b/i.test(expression)) return 'RECENT';
  if (intent.temporal?.requiresCurrentData) return 'CURRENT';
  return 'ANY';
}

function currentExternalFreshnessRequirement(intent: NormalizedIntent): ContextFreshnessRequirement {
  const required = freshnessRequirement(intent);
  return required === 'ANY' ? 'CURRENT' : required;
}

function authorityRequirement(request: string): ContextNeed['authorityRequirement'] {
  if (/\b(?:official|authoritative|primary source|system of record|vendor documentation)\b/i.test(request))
    return 'AUTHORITATIVE';
  if (/\b(?:trusted|verified|reliable|evidence|source)\b/i.test(request)) return 'TRUSTED';
  return 'ANY';
}

function needSatisfied(
  need: ContextNeed,
  evidence: readonly EvidenceItem[],
  resolution: CapabilityResolution | undefined,
  availableSourceKinds: readonly ContextSourceKind[],
): boolean {
  if (need.evidenceRequirement === 'NONE') return resolution?.status === 'available';
  if (need.sourceKinds.some((kind) => availableSourceKinds.includes(kind))) return true;
  const authorityRequired =
    need.authorityRequirement === 'AUTHORITATIVE'
      ? 0.8
      : need.authorityRequirement === 'TRUSTED'
        ? 0.6
        : 0;
  const freshnessRequired = minimumFreshness(need.freshnessRequirement);
  const fetchAvailable = resolution?.requiredCapabilities.includes('WEB_FETCH') ?? false;
  return evidence.some((item) => {
    const sourceKind = item.source.sourceKind ?? sourceKindForType(item.source.type);
    if (!need.sourceKinds.includes(sourceKind)) return false;
    if (item.authority < authorityRequired || item.freshness < freshnessRequired) return false;
    if (item.confidence < (item.capability === undefined ? 0.6 : 0.75)) return false;
    if (
      need.requiredCapability === 'WEB_RETRIEVAL' &&
      item.capability === 'WEB_SEARCH' &&
      fetchAvailable
    ) {
      return false;
    }
    return (
      item.capability === undefined ||
      item.capability === need.requiredCapability ||
      resolution?.requiredCapabilities.includes(item.capability) === true
    );
  });
}

function minimumFreshness(requirement: ContextFreshnessRequirement): number {
  switch (requirement) {
    case 'CURRENT':
    case 'LATEST':
    case 'TODAY':
      return 0.8;
    case 'THIS_WEEK':
    case 'RECENT':
      return 0.6;
    case 'HISTORICAL':
    case 'ANY':
    case 'NONE':
      return 0;
  }
}

function sourceKindForType(type: EvidenceItem['source']['type']): ContextSourceKind {
  switch (type) {
    case 'file':
    case 'document':
      return 'FILE';
    case 'web':
    case 'external':
      return 'WEB';
    case 'memory':
      return 'MEMORY';
    case 'mcp':
      return 'MCP';
    case 'database':
      return 'DATABASE';
    case 'api':
      return 'API';
    case 'task-state':
      return 'TASK_STATE';
    case 'artifact':
      return 'ARTIFACT';
    case 'application-context':
      return 'APPLICATION_CONTEXT';
    default:
      return 'APPLICATION_CONTEXT';
  }
}

function dedupeNeeds(needs: readonly ContextNeed[]): ContextNeed[] {
  const byType = new Map<ContextNeedType, ContextNeed>();
  for (const need of needs) if (!byType.has(need.type)) byType.set(need.type, need);
  return [...byType.values()];
}
