import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { Tool, ToolExecutionResult } from '../tools/tool.js';
import type { ContextIntelligenceConfig } from './config.js';
import type {
  NormalizedIntent,
  OffloadedArtifact,
  SourceMetadata,
  ToolFailureClassification,
  ToolObservation,
  ToolOutcome,
} from './contracts.js';
import { StructuredResultShaper } from './structured-result-shaper.js';
import { inferGenericCapabilities } from './capability-intelligence.js';
import {
  containmentScore,
  dedupeStrings,
  id,
  now,
  parseJson,
  preview,
  provenance,
  sourceMetadata,
  stableHash,
} from './utils.js';

export type ProcessedObservation = {
  result: ToolExecutionResult;
  observation: ToolObservation;
  offloaded?: OffloadedArtifact;
};

export class ObservationIntelligence {
  constructor(
    private readonly config: ContextIntelligenceConfig,
    private readonly artifactStore?: ArtifactStore,
    private readonly shaper = new StructuredResultShaper(),
  ) {}

  async process(input: {
    tool: Tool;
    toolCallId: string;
    output: ToolExecutionResult;
    intent: NormalizedIntent;
    sessionId: string;
    turnId: string;
  }): Promise<ProcessedObservation> {
    const createdAt = now();
    const rawContent = input.output.content ?? '';
    const parsed = parseJson(rawContent);
    const outcome = classifyOutcome(input.output, parsed);
    const failureClassification = classifyFailure(outcome, rawContent);
    const source = sourceFor(input.tool, input.output, createdAt, this.config);
    const sourceProvenance = provenance(
      source,
      'retrieved',
      'observation-intelligence',
      [input.toolCallId],
      {
        outcome,
        tool: input.tool.name,
      },
    );
    let content = rawContent;
    let structured: unknown = parsed;
    let offloaded: OffloadedArtifact | undefined;

    if (this.config.features.structuredShaping && parsed !== undefined) {
      const shaped = this.shaper.shape(parsed, {
        pageSize: 25,
        maximumRows: 50,
        identifierFields: inferIdentifierFields(parsed),
      });
      structured = shaped;
      content = JSON.stringify(shaped);
    }

    if (
      this.config.features.offloading &&
      rawContent.length > this.config.hygiene.offloadThresholdChars &&
      this.artifactStore
    ) {
      const artifact = await this.artifactStore.put(rawContent, {
        contentType: inferContentType(parsed),
        metadata: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: input.toolCallId,
          toolName: input.tool.name,
          purpose: 'context-intelligence-offload',
        },
      });
      const summary = observationSummary(content, parsed);
      const reference = `artifact://${artifact.id}`;
      content = `${summary}\n\n[Full result offloaded as artifact ${artifact.id}; request drill-down when needed.]`;
      offloaded = {
        id: id('offload'),
        artifactId: artifact.id,
        originalItemId: input.toolCallId,
        kind: 'tool-result',
        summary,
        size: artifact.size,
        contentType: artifact.contentType,
        reference,
        recall: {
          capability: 'ARTIFACT_READ',
          inputs: { artifactId: artifact.id, referenceOrigin: 'context_offload' },
        },
        source,
        provenance: sourceProvenance,
        lifecycleState: 'offloaded',
        createdAt,
      };
      structured = {
        artifactId: artifact.id,
        reference,
        summary,
        originalContentType: artifact.contentType,
        originalSize: artifact.size,
      };
    } else if (content.length > this.config.hygiene.offloadThresholdChars) {
      content = compressText(content, this.config.hygiene.offloadThresholdChars);
    }

    const facts = extractFacts(content, structured);
    const identifiers = extractIdentifiers(structured ?? content);
    const links = extractLinks(parsed, input.output.metadata);
    const errors =
      outcome === 'error' || outcome === 'denied' || outcome === 'malformed'
        ? [preview(rawContent, 1_000)]
        : [];
    const requiresFollowUp =
      outcome === 'empty' ||
      outcome === 'partial' ||
      outcome === 'error' ||
      containmentScore(input.intent.normalizedRequest, content) < 0.08;
    const followUpReason = requiresFollowUp
      ? outcome === 'success'
        ? 'The observation has weak overlap with the active intent.'
        : `The tool outcome was ${outcome}.`
      : undefined;
    const observation: ToolObservation = {
      id: id('observation'),
      toolCallId: input.toolCallId,
      toolName: input.tool.name,
      outcome,
      content,
      ...(structured === undefined ? {} : { structured }),
      facts,
      identifiers,
      errors,
      source,
      provenance: sourceProvenance,
      ...(offloaded === undefined ? {} : { artifactId: offloaded.artifactId }),
      requiresFollowUp,
      ...(followUpReason === undefined ? {} : { followUpReason }),
      ...(failureClassification === undefined ? {} : { failureClassification }),
      ...(links.length === 0 ? {} : { links }),
      createdAt,
    };
    return {
      result: {
        content,
        isError: outcome === 'error' || outcome === 'denied' || outcome === 'malformed',
        metadata: {
          ...input.output.metadata,
          contextIntelligence: {
            observationId: observation.id,
            outcome,
            factCount: facts.length,
            identifierCount: identifiers.length,
            requiresFollowUp,
            ...(offloaded === undefined ? {} : { artifactId: offloaded.artifactId }),
          },
        },
      },
      observation,
      ...(offloaded === undefined ? {} : { offloaded }),
    };
  }
}

function classifyOutcome(output: ToolExecutionResult, parsed: unknown): ToolOutcome {
  if (output.isError) {
    return /permission|denied|forbidden|unauthori[sz]ed/i.test(output.content) ? 'denied' : 'error';
  }
  if (
    output.metadata?.returnedChars === 0 ||
    (output.metadata?.returnedLines === 1 &&
      output.content.replace(/^\s*\d+\t/gm, '').trim().length === 0)
  ) {
    return 'empty';
  }
  if (!output.content.trim() || output.content.trim() === '[]' || output.content.trim() === '{}')
    return 'empty';
  if (
    output.metadata?.partial === true ||
    output.metadata?.hasMore === true ||
    output.metadata?.followed === false ||
    hasPagination(parsed)
  )
    return 'partial';
  if (/^[\[{]/.test(output.content.trim()) && parsed === undefined) return 'malformed';
  return 'success';
}

function classifyFailure(
  outcome: ToolOutcome,
  content: string,
): ToolFailureClassification | undefined {
  if (outcome === 'success' || outcome === 'partial') return undefined;
  if (outcome === 'empty') return 'empty';
  if (outcome === 'malformed') return 'malformed';
  if (outcome === 'denied') return 'authorization_denied';
  if (/\b(?:timed?\s*out|timeout|deadline exceeded)\b/i.test(content)) return 'timeout';
  if (/\b(?:rate limit|too many requests|quota|429)\b/i.test(content)) return 'rate_limited';
  if (/\b(?:not found|does not exist|enoent|404)\b/i.test(content)) return 'not_found';
  if (/\b(?:invalid (?:input|argument)|validation|schema|required)\b/i.test(content))
    return 'invalid_input';
  if (/\b(?:unsupported|not implemented|unknown tool|capability unavailable)\b/i.test(content))
    return 'unsupported';
  if (/\b(?:network|connection|dns|socket|econn|gateway|service unavailable|502|503|504)\b/i.test(content))
    return 'network';
  return 'unknown';
}

function sourceFor(
  tool: Tool,
  output: ToolExecutionResult,
  timestamp: string,
  config: ContextIntelligenceConfig,
): SourceMetadata {
  const supplied = output.metadata?.source;
  const metadata =
    supplied && typeof supplied === 'object' && !Array.isArray(supplied)
      ? (supplied as Partial<SourceMetadata>)
      : {};
  const configured = config.sourceMetadata.find(
    (source) =>
      source.id === metadata.id ||
      source.id === `tool:${tool.name}` ||
      source.name.toLowerCase() === tool.name.toLowerCase(),
  );
  const sourceId = metadata.id ?? configured?.id ?? `tool:${tool.name}`;
  const genericCapabilities = inferGenericCapabilities(tool);
  const inferred = inferredSource(genericCapabilities);
  const outputProvider =
    typeof output.metadata?.provider === 'string' ? output.metadata.provider : undefined;
  const observedExtractionContext = extractionContextFrom(output.metadata);
  const extractionContext =
    metadata.extractionContext ?? configured?.extractionContext ?? observedExtractionContext;
  const authority =
    config.sourceAuthority[sourceId] ??
    config.sourceAuthority[tool.name] ??
    metadata.authority ??
    configured?.authority ??
    tool.contextMetadata?.authority ??
    (genericCapabilities.includes('FILE_READ') ? 0.9 : inferred.type === 'external' ? 0.65 : 0.6);
  return sourceMetadata({
    id: sourceId,
    name: metadata.name ?? configured?.name ?? tool.name,
    type: metadata.type ?? configured?.type ?? inferred.type,
    ...((metadata.sourceKind ?? configured?.sourceKind ?? inferred.sourceKind) === undefined
      ? {}
      : { sourceKind: metadata.sourceKind ?? configured?.sourceKind ?? inferred.sourceKind! }),
    provider: metadata.provider ?? outputProvider ?? tool.name,
    authority,
    observedAt: metadata.observedAt ?? timestamp,
    retrievedAt: timestamp,
    ...((metadata.sourceTimestamp ?? configured?.sourceTimestamp)
      ? { sourceTimestamp: metadata.sourceTimestamp ?? configured!.sourceTimestamp }
      : {}),
    ...(extractionContext === undefined ? {} : { extractionContext }),
    evidenceIdentity:
      metadata.evidenceIdentity ?? configured?.evidenceIdentity ?? `${sourceId}:${inputIdentity(output)}`,
    ...((metadata.version ?? configured?.version)
      ? { version: metadata.version ?? configured!.version }
      : {}),
    ...((metadata.scope ?? configured?.scope)
      ? { scope: metadata.scope ?? configured!.scope }
      : {}),
    ...((metadata.uri ?? configured?.uri) ? { uri: metadata.uri ?? configured!.uri } : {}),
    contentHash: metadata.contentHash ?? configured?.contentHash ?? stableHash(output.content),
    ...((metadata.policyLabels ?? configured?.policyLabels)
      ? { policyLabels: metadata.policyLabels ?? configured!.policyLabels }
      : {}),
  });
}

function extractionContextFrom(
  metadata: ToolExecutionResult['metadata'],
): string | undefined {
  if (!metadata) return undefined;
  if (
    typeof metadata.offset === 'number' &&
    Number.isInteger(metadata.offset) &&
    typeof metadata.returnedLines === 'number' &&
    Number.isInteger(metadata.returnedLines)
  ) {
    const first = metadata.offset + 1;
    const last = metadata.offset + Math.max(1, metadata.returnedLines);
    return `lines ${first}-${last}`;
  }
  if (
    typeof metadata.offset === 'number' &&
    Number.isInteger(metadata.offset) &&
    typeof metadata.returnedChars === 'number' &&
    Number.isInteger(metadata.returnedChars)
  ) {
    const last = metadata.offset + Math.max(0, metadata.returnedChars);
    return `characters ${metadata.offset}-${last}`;
  }
  return undefined;
}

function inferredSource(
  capabilities: readonly string[],
): { type: SourceMetadata['type']; sourceKind?: SourceMetadata['sourceKind'] } {
  if (capabilities.some((capability) => capability === 'WEB_SEARCH' || capability === 'WEB_FETCH'))
    return { type: 'external', sourceKind: 'WEB' };
  if (capabilities.includes('FILE_DISCOVERY') || capabilities.includes('FILE_READ')) {
    return { type: 'file', sourceKind: 'FILE' };
  }
  if (capabilities.includes('DATABASE_QUERY')) return { type: 'database', sourceKind: 'DATABASE' };
  if (capabilities.includes('API_RETRIEVAL')) return { type: 'api', sourceKind: 'API' };
  if (capabilities.includes('MCP_RETRIEVAL')) return { type: 'mcp', sourceKind: 'MCP' };
  if (capabilities.includes('MEMORY_RECALL')) return { type: 'memory', sourceKind: 'MEMORY' };
  if (capabilities.includes('TASK_STATE_READ'))
    return { type: 'task-state', sourceKind: 'TASK_STATE' };
  if (capabilities.includes('ARTIFACT_DISCOVERY') || capabilities.includes('ARTIFACT_READ')) {
    return { type: 'artifact', sourceKind: 'ARTIFACT' };
  }
  if (capabilities.includes('APPLICATION_CONTEXT_READ'))
    return { type: 'application-context', sourceKind: 'APPLICATION_CONTEXT' };
  return { type: 'tool' };
}

function inputIdentity(output: ToolExecutionResult): string {
  return stableHash({ content: output.content, source: output.metadata?.source });
}

function hasPagination(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.nextPage || record.nextToken || record.cursor || record.hasMore === true);
}

function inferIdentifierFields(value: unknown): string[] {
  const records = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const first = records.find(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry),
  ) as Record<string, unknown> | undefined;
  return first
    ? Object.keys(first)
        .filter((key) => /(^id$|id$|key|uuid|code|number)$/i.test(key))
        .slice(0, 8)
    : [];
}

function extractIdentifiers(value: unknown): string[] {
  if (typeof value === 'string')
    return dedupeStrings(value.match(/\b(?:[A-Z]{2,}[-_:])?[A-Z0-9]{6,}\b/g) ?? []).slice(0, 50);
  const values: string[] = [];
  walk(value, (key, entry) => {
    if (
      /(^id$|id$|key|uuid|code|number)$/i.test(key) &&
      ['string', 'number'].includes(typeof entry)
    )
      values.push(String(entry));
  });
  return dedupeStrings(values).slice(0, 100);
}

function extractFacts(content: string, structured: unknown): string[] {
  if (structured && typeof structured === 'object') {
    const record = structured as Record<string, unknown>;
    const facts = ['populationCount', 'filteredCount', 'returnedCount', 'pageCount', 'totals']
      .filter((key) => key in record)
      .map((key) => `${key}: ${JSON.stringify(record[key])}`);
    if (facts.length) return facts;
  }
  return dedupeStrings(
    content.split(/(?<=[.!?])\s+|\n+/).filter((line) => line.length >= 4 && line.length <= 500),
  ).slice(0, 20);
}

function extractLinks(value: unknown, metadata: Record<string, unknown> | undefined): string[] {
  const links: string[] = [];
  const collect = (entry: unknown): void => {
    if (typeof entry !== 'string') return;
    const matches = entry.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    links.push(...matches.map((match) => match.replace(/[),.;]+$/, '')));
  };
  walk(value, (_key, entry) => collect(entry));
  walk(metadata, (_key, entry) => collect(entry));
  collect(metadata?.url);
  return dedupeStrings(links).slice(0, 50);
}

function walk(value: unknown, visitor: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 5 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) walk(entry, visitor, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    visitor(key, entry);
    walk(entry, visitor, depth + 1);
  }
}

function observationSummary(content: string, parsed: unknown): string {
  if (parsed !== undefined) {
    const kind = Array.isArray(parsed)
      ? `array with ${parsed.length} entries`
      : 'structured object';
    return `Tool returned a ${kind}. Curated result: ${preview(content, 4_000)}`;
  }
  return preview(content, 4_000);
}

function compressText(value: string, maximum: number): string {
  const keep = Math.max(500, Math.floor((maximum - 200) / 2));
  return `${value.slice(0, keep)}\n\n[…${value.length - keep * 2} characters offloaded from active context…]\n\n${value.slice(-keep)}`;
}

function inferContentType(parsed: unknown): string {
  return parsed === undefined ? 'text/plain' : 'application/json';
}
