import type {
  CapabilityResolution,
  ContextNeed,
  ContextScope,
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
    const suppliedUrl = intent.entities
      .find((entity) => entity.type === 'uri')
      ?.value.replace(/[),.;]+$/, '');

    if (requiresCurrentExternalInformation(intent)) {
      needs.push({
        id: `${requestId}:CURRENT_EXTERNAL_INFORMATION`,
        type: 'CURRENT_EXTERNAL_INFORMATION',
        required: true,
        requiredInformation: ['current externally observable state'],
        missingInformation: ['current external evidence'],
        reason: 'The request depends on information that can change after model training.',
        sourceRequirement: 'external',
        freshnessRequirement: currentExternalFreshnessRequirement(intent),
        authorityRequirement: 'TRUSTED',
        scope: structuredClone(scope),
        evidenceRequirement: 'REQUIRED',
        requiredCapability: suppliedUrl ? 'WEB_FETCH' : 'WEB_RETRIEVAL',
        priority: 'critical',
        status: 'missing',
        inputs: {
          query: intent.normalizedRequest,
          ...(suppliedUrl === undefined ? {} : { url: suppliedUrl }),
        },
      });
    }

    const fileReference = extractFileReference(request);
    const requiresFileContent = explicitlyRequiresFileContent(request) && !suppliedUrl;
    if ((fileReference && intent.operation !== 'create') || requiresFileContent) {
      needs.push({
        id: `${requestId}:FILE_INFORMATION`,
        type: 'FILE_INFORMATION',
        required: true,
        requiredInformation: ['workspace file contents'],
        missingInformation: [fileReference ? 'file evidence' : 'file path'],
        reason: fileReference
          ? 'The requested answer depends on the contents of a workspace file.'
          : 'The request asks for file contents but does not identify the file to read.',
        sourceRequirement: 'workspace',
        freshnessRequirement: freshnessRequirement(intent),
        authorityRequirement: 'AUTHORITATIVE',
        scope: structuredClone(scope),
        evidenceRequirement: 'REQUIRED',
        requiredCapability: 'FILE_READ',
        priority: 'high',
        status: fileReference ? 'missing' : 'clarification_required',
        inputs: fileReference
          ? { path: fileReference.path, referenceOrigin: fileReference.origin }
          : {},
      });
    }

    if (
      intent.operation === 'create' &&
      /(?:\b(?:markdown|document|report|artifact)\b|\.md\b)/i.test(
        `${request} ${intent.requestedOutput ?? ''}`,
      )
    ) {
      const markdown = /(?:\bmarkdown\b|\.md\b)/i.test(
        `${request} ${intent.requestedOutput ?? ''}`,
      );
      needs.push({
        id: `${requestId}:DOCUMENT_CREATION`,
        type: 'DOCUMENT_CREATION',
        required: true,
        requiredInformation: ['requested document output capability'],
        missingInformation: ['runtime document creation capability'],
        reason:
          'The requested deliverable must be created through an available runtime capability.',
        sourceRequirement: 'any',
        freshnessRequirement: 'ANY',
        authorityRequirement: 'ANY',
        scope: structuredClone(scope),
        evidenceRequirement: 'NONE',
        requiredCapability: markdown ? 'MARKDOWN_ARTIFACT_CREATE' : 'DOCUMENT_ARTIFACT_CREATE',
        priority: 'high',
        status: 'missing',
        inputs: {},
      });
    }

    return needs;
  }

  assess(
    needs: readonly ContextNeed[],
    evidence: readonly EvidenceItem[],
    resolutions: readonly CapabilityResolution[],
  ): ContextNeed[] {
    return needs.map((need) => {
      if (need.status === 'clarification_required') return need;
      const resolution = resolutions.find((entry) => entry.needId === need.id);
      if (need.evidenceRequirement !== 'NONE' && needSatisfied(need, evidence, resolution)) {
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

function requiresCurrentExternalInformation(intent: NormalizedIntent): boolean {
  const request = intent.originalRequest;
  const hasExternalUri = intent.entities.some((entity) => entity.type === 'uri');
  const stronglyExternal =
    /\b(web|internet|online|external|official (?:information|sources?)|news|weather|stock|share price|exchange rate|current president|current ceo|latest release|latest version|today'?s|search online)\b/i.test(
      request,
    );
  const evidenceRequested = /\b(sources?|evidence|verify|look up)\b/i.test(request);
  const explicitlyLocal =
    Boolean(extractFileReference(request)) || explicitlyRequiresFileContent(request);
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
    ...(directive.match(/(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s"'<>|?*]+/g) ?? []),
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
  if (quoted || fileLike || explicitlyRelative || windowsAbsolute) return true;
  const referenceCue = new RegExp(
    `(?:\\b(?:file|path|attachment|artifact|document|read|open|inspect|review|from|in)\\b.{0,40}${escaped}|${escaped}.{0,40}\\b(?:file|path|attachment|artifact|document)\\b)`,
    'i',
  );
  return referenceCue.test(request);
}

function stripAttachedContent(request: string): string {
  return request.replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function freshnessRequirement(intent: NormalizedIntent): ContextNeed['freshnessRequirement'] {
  if (!intent.temporal?.requiresCurrentData) return 'ANY';
  return /\b(recent(?:ly|\s+changes?)?|this\s+week|last\s+\d+)\b/i.test(intent.temporal.expression)
    ? 'RECENT'
    : 'CURRENT';
}

function currentExternalFreshnessRequirement(
  intent: NormalizedIntent,
): ContextNeed['freshnessRequirement'] {
  const required = freshnessRequirement(intent);
  return required === 'ANY' ? 'CURRENT' : required;
}

function needSatisfied(
  need: ContextNeed,
  evidence: readonly EvidenceItem[],
  resolution: CapabilityResolution | undefined,
): boolean {
  if (need.evidenceRequirement === 'NONE') return resolution?.status === 'available';
  const authorityRequired =
    need.authorityRequirement === 'AUTHORITATIVE'
      ? 0.8
      : need.authorityRequirement === 'TRUSTED'
        ? 0.6
        : 0;
  if (need.type === 'FILE_INFORMATION') {
    return evidence.some(
      (item) =>
        item.capability === 'FILE_READ' &&
        item.confidence >= 0.8 &&
        item.authority >= authorityRequired,
    );
  }
  if (need.type === 'CURRENT_EXTERNAL_INFORMATION') {
    const fetchAvailable = resolution?.requiredCapabilities.includes('WEB_FETCH') ?? false;
    return evidence.some(
      (item) =>
        item.source.type === 'external' &&
        item.freshness >= 0.75 &&
        item.authority >= authorityRequired &&
        item.confidence >= (item.capability === undefined ? 0.6 : 0.8) &&
        (item.capability === undefined ||
          item.capability === 'WEB_FETCH' ||
          (!fetchAvailable && item.capability === 'WEB_SEARCH')),
    );
  }
  return true;
}
