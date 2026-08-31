import type {
  ContextConflict,
  ContextItem,
  CrossDocumentSynthesis,
  EvidenceItem,
} from './contracts.js';
import {
  clamp,
  dedupeStrings,
  estimateTokens,
  id,
  now,
  preview,
  provenance,
  sourceMetadata,
} from './utils.js';

/**
 * Synthesizes extracted evidence across source types without loading complete
 * documents into active context. Inputs have already passed retrieval, observation,
 * and evidence admission; this layer combines references and claims only.
 */
export class CrossDocumentIntelligence {
  synthesize(input: {
    requestId: string;
    items: readonly ContextItem[];
    evidence: readonly EvidenceItem[];
    conflicts: readonly ContextConflict[];
  }): { record: CrossDocumentSynthesis; item?: ContextItem } {
    const candidates = input.items
      .filter((item) =>
        ['evidence', 'memory', 'observation', 'artifact-handle'].includes(item.kind),
      )
      .sort((left, right) => utility(right) - utility(left))
      .slice(0, 40);
    const sourceIds = dedupeStrings(candidates.map((item) => item.source.id));
    const claimMap = new Map<string, ContextItem[]>();
    for (const item of candidates) {
      for (const key of item.claimKeys ?? []) {
        const entries = claimMap.get(key) ?? [];
        entries.push(item);
        claimMap.set(key, entries);
      }
    }
    const claimGroups = [...claimMap.entries()]
      .map(([claimKey, entries]) => ({
        claimKey,
        itemIds: dedupeStrings(entries.map((entry) => entry.id)),
        sourceIds: dedupeStrings(entries.map((entry) => entry.source.id)),
      }))
      .filter((group) => group.sourceIds.length > 1)
      .slice(0, 50);
    const createdAt = now();
    const source = sourceMetadata({
      id: `cross-document:${input.requestId}`,
      name: 'Cross-document evidence synthesis',
      type: 'derived',
      sourceKind: 'APPLICATION_CONTEXT',
      authority: candidates.length === 0 ? 0.5 : Math.max(...candidates.map((item) => item.authority)),
      observedAt: createdAt,
      evidenceIdentity: `cross-document:${input.requestId}`,
    });
    const sourceProvenance = provenance(
      source,
      'synthesized',
      'cross-document-intelligence',
      candidates.map((item) => item.provenance.id),
      {
        sourceCount: sourceIds.length,
        itemCount: candidates.length,
        claimGroupCount: claimGroups.length,
      },
    );
    const summary = renderSummary(candidates, claimGroups, input.conflicts);
    const record: CrossDocumentSynthesis = {
      id: id('cross_document'),
      sourceIds,
      itemIds: candidates.map((item) => item.id),
      evidenceIds: input.evidence.map((item) => item.id),
      claimGroups,
      conflictIds: input.conflicts.map((conflict) => conflict.id),
      summary,
      provenance: sourceProvenance,
      createdAt,
    };
    if (sourceIds.length < 2 || !summary) return { record };
    return {
      record,
      item: {
        id: `context:${record.id}`,
        kind: 'finding',
        title: 'Cross-document synthesis',
        content: summary,
        structured: {
          sourceIds,
          claimGroups,
          conflictIds: record.conflictIds,
        },
        source,
        provenance: sourceProvenance,
        dependencyIds: record.itemIds,
        lifecycleState: 'admitted',
        relevance: 0.9,
        confidence: clamp(
          candidates.reduce((sum, item) => sum + item.confidence, 0) /
            Math.max(1, candidates.length),
        ),
        authority: source.authority,
        freshness: candidates.length
          ? Math.min(...candidates.map((item) => item.freshness))
          : 0.5,
        priority: input.conflicts.some((conflict) => conflict.resolution === 'unresolved')
          ? 'high'
          : 'normal',
        tokenEstimate: estimateTokens(summary),
        createdAt,
        claimKeys: claimGroups.map((group) => group.claimKey),
        active: true,
      },
    };
  }
}

function renderSummary(
  items: readonly ContextItem[],
  claimGroups: readonly CrossDocumentSynthesis['claimGroups'][number][],
  conflicts: readonly ContextConflict[],
): string {
  if (items.length === 0) return '';
  const sources = items
    .map(
      (item) =>
        `- [${item.source.id}] ${item.source.name} (${item.source.type}, authority ${item.authority.toFixed(2)}, freshness ${item.freshness.toFixed(2)}): ${preview(item.content, 500)}`,
    )
    .slice(0, 20);
  return [
    `Sources synthesized: ${dedupeStrings(items.map((item) => item.source.id)).length}.`,
    ...(claimGroups.length
      ? [
          'Cross-source claim groups:',
          ...claimGroups.slice(0, 20).map(
            (group) =>
              `- ${group.claimKey}: ${group.sourceIds.map((sourceId) => `[${sourceId}]`).join(', ')}`,
          ),
        ]
      : []),
    ...(conflicts.length
      ? [
          'Conflicts retained:',
          ...conflicts.slice(0, 20).map((conflict) => `- ${conflict.explanation}`),
        ]
      : []),
    'Selected evidence extracts:',
    ...sources,
  ].join('\n');
}

function utility(item: ContextItem): number {
  return (
    item.relevance * 0.35 +
    item.authority * 0.25 +
    item.freshness * 0.15 +
    item.confidence * 0.15 +
    (item.priority === 'essential' ? 0.1 : item.priority === 'high' ? 0.075 : 0.025)
  );
}
