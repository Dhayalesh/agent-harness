import type {
  CapabilityResolution,
  ContextNeed,
  ContextScope,
  EvidenceItem,
  NormalizedIntent,
} from './contracts.js';
import { id } from './utils.js';

/** Identifies concrete information gaps before retrieval or tool selection occurs. */
export class ContextNeedIntelligence {
  identify(
    intent: NormalizedIntent,
    scope: ContextScope,
    requestId = id('request'),
  ): ContextNeed[] {
    const needs: ContextNeed[] = [];
    const request = intent.originalRequest;

    if (requiresCurrentExternalInformation(intent)) {
      const suppliedUrl = intent.entities
        .find((entity) => entity.type === 'uri')
        ?.value.replace(/[),.;]+$/, '');
      needs.push({
        id: `${requestId}:CURRENT_EXTERNAL_INFORMATION`,
        type: 'CURRENT_EXTERNAL_INFORMATION',
        required: true,
        requiredInformation: ['current externally observable state'],
        missingInformation: ['current external evidence'],
        reason: 'The request depends on information that can change after model training.',
        sourceRequirement: 'external',
        freshnessRequirement: 'CURRENT',
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

    const filePath = extractFilePath(request);
    if ((filePath && intent.operation !== 'create') || explicitlyRequiresFileContent(request)) {
      needs.push({
        id: `${requestId}:FILE_INFORMATION`,
        type: 'FILE_INFORMATION',
        required: true,
        requiredInformation: ['workspace file contents'],
        missingInformation: [filePath ? 'file evidence' : 'file path'],
        reason: filePath
          ? 'The requested answer depends on the contents of a workspace file.'
          : 'The request asks for file contents but does not identify the file to read.',
        sourceRequirement: 'workspace',
        freshnessRequirement: 'CURRENT',
        authorityRequirement: 'AUTHORITATIVE',
        scope: structuredClone(scope),
        evidenceRequirement: 'REQUIRED',
        requiredCapability: 'FILE_READ',
        priority: 'high',
        status: filePath ? 'missing' : 'clarification_required',
        inputs: filePath ? { path: filePath } : {},
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
        return { ...need, status: 'unavailable' as const };
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
    /\b(web|internet|online|external|news|weather|stock|share price|exchange rate|current president|current ceo|latest release|latest version|today'?s|search online)\b/i.test(
      request,
    );
  const evidenceRequested = /\b(sources?|evidence|verify|look up)\b/i.test(request);
  const explicitlyLocal =
    /\b(code|codebase|repository|repo|workspace|runtime|session|conversation|local file|source file|this file|the file)\b/i.test(
      request,
    );
  return (
    hasExternalUri ||
    stronglyExternal ||
    (evidenceRequested && !explicitlyLocal) ||
    Boolean(intent.temporal?.requiresCurrentData && !explicitlyLocal)
  );
}

function explicitlyRequiresFileContent(request: string): boolean {
  return /\b(read|open|inspect|review|summari[sz]e|use)\b.{0,40}\b(file|attachment)\b/i.test(
    request,
  );
}

function extractFilePath(request: string): string | undefined {
  const candidates = [
    ...(request.match(/`([^`\r\n]+)`/g) ?? []).map((value) => value.slice(1, -1)),
    ...(request.match(/(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s"'<>|?*]+/g) ?? []),
    ...(
      request.match(/(?:^|\s)([\w.-]+(?:[\\/][\w .-]+)*\.[A-Za-z0-9]{1,12})(?=\s|$|[,.):;])/g) ?? []
    ).map((value) => value.trim()),
  ];
  return candidates.find(
    (value) =>
      value.length > 0 &&
      value.length <= 4_096 &&
      (/[/\\]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value)),
  );
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
