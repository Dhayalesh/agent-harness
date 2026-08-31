import type {
  ContextFeedbackOutcome,
  ContextFeedbackRecord,
  ContextFeedbackReference,
  ContextLifecycleEvent,
  ContextQualityIssue,
  ContextRuntimeDirective,
  EvidenceGroup,
  EvidenceItem,
  FinalizedContext,
  MemoryRecallAssessment,
  RuntimeRetrievalOperation,
} from './contracts.js';
import { now, stableHash } from './utils.js';

export type FeedbackEvidenceRejection = {
  observationId: string;
  reasons: readonly string[];
};

export type ContextFeedbackInput = {
  requestId: string;
  operations: readonly RuntimeRetrievalOperation[];
  evidence: readonly EvidenceItem[];
  evidenceGroups: readonly EvidenceGroup[];
  rejectedEvidence: readonly FeedbackEvidenceRejection[];
  memoryAssessment: MemoryRecallAssessment;
  qualityIssues: readonly ContextQualityIssue[];
  finalized: FinalizedContext;
  directive: ContextRuntimeDirective;
  lifecycle: readonly ContextLifecycleEvent[];
};

type FeedbackCandidate = Omit<ContextFeedbackRecord, 'id' | 'at' | 'sourceReferences'> & {
  subject: string;
  sourceReferences?: readonly ContextFeedbackReference[];
};

/**
 * Bounded feedback ledger derived only from concrete runtime, evidence, memory,
 * lifecycle, finalization, and quality-gate facts. References are typed stable
 * identities rather than pointers into an independently evicted event ring.
 */
export class ContextFeedbackIntelligence {
  private records: ContextFeedbackRecord[];

  constructor(
    initial: readonly ContextFeedbackRecord[] = [],
    private readonly maximumRecords = 200,
    private readonly maximumSourceReferences = 8,
  ) {
    this.records = initial.slice(-maximumRecords).map((record) => structuredClone(record));
  }

  collect(input: ContextFeedbackInput): readonly ContextFeedbackRecord[] {
    const activeIds = new Set(input.finalized.activeItemIds);
    const canonicalIds = new Set(input.finalized.canonicalItemIds);
    const evidenceByObservation = new Map(
      input.evidence
        .filter((evidence) => evidence.observationId !== undefined)
        .map((evidence) => [evidence.observationId!, evidence]),
    );
    const rejectionByObservation = new Map(
      input.rejectedEvidence.map((rejection) => [rejection.observationId, rejection]),
    );
    const issueByItem = issuesByItem(input.qualityIssues);

    for (const operation of input.operations) {
      if (operation.requestId !== input.requestId || operation.status === 'planned') continue;
      const evidence = operation.observationId
        ? evidenceByObservation.get(operation.observationId)
        : undefined;
      const rejection = operation.observationId
        ? rejectionByObservation.get(operation.observationId)
        : undefined;
      const issues = evidence ? issueByItem.get(evidence.id) ?? [] : [];
      const classification = classifyOperation(
        operation,
        evidence,
        rejection,
        issues,
        activeIds,
        canonicalIds,
      );
      if (!classification) continue;
      const sourceReferences: ContextFeedbackReference[] = [
        reference('operation', operation.id),
        ...(operation.observationId
          ? [reference('observation', operation.observationId)]
          : []),
        ...(evidence ? [reference('evidence', evidence.evidenceIdentity)] : []),
      ];
      const common = {
        requestId: input.requestId,
        outcome: classification.outcome,
        reasonCode: classification.reasonCode,
        subject: operation.id,
        operationId: operation.id,
        ...(operation.observationId === undefined
          ? {}
          : { observationId: operation.observationId }),
        ...(evidence === undefined ? {} : { evidenceId: evidence.id }),
        toolName: operation.toolName,
        capability: operation.capability,
        sourceReferences,
      } as const;
      this.add({ category: 'retrieval', ...common });
      this.add({ category: 'tool_choice', ...common });
    }

    for (const evidence of input.evidence) {
      if (!evidence.retrievalResultId) continue;
      const issues = issueByItem.get(evidence.id) ?? [];
      const issueClassification = classifyIssues(issues);
      const outcome = activeIds.has(evidence.id)
        ? ('useful' as const)
        : issueClassification?.outcome ??
          (canonicalIds.has(evidence.id) ? ('retained' as const) : ('rejected' as const));
      const reasonCode = activeIds.has(evidence.id)
        ? 'selected_for_model'
        : issueClassification?.reasonCode ??
          (canonicalIds.has(evidence.id) ? 'admitted_not_selected' : 'not_admitted');
      this.add({
        requestId: input.requestId,
        category: 'retrieval',
        outcome,
        reasonCode,
        subject: evidence.retrievalResultId,
        evidenceId: evidence.id,
        retrievalResultId: evidence.retrievalResultId,
        sourceReferences: [
          reference('retrieval_result', evidence.retrievalResultId),
          reference('evidence', evidence.evidenceIdentity),
        ],
      });
    }

    for (const group of input.evidenceGroups) {
      if (group.duplicateCount <= 0) continue;
      this.add({
        requestId: input.requestId,
        category: 'retrieval',
        outcome: 'duplicate',
        reasonCode: 'duplicate_evidence_identity',
        subject: group.id,
        evidenceId: group.strongestEvidenceId,
        sourceReferences: [reference('evidence_group', group.id)],
      });
    }

    for (const memory of input.memoryAssessment.retained) {
      this.add({
        requestId: input.requestId,
        category: 'memory',
        outcome: 'retained',
        reasonCode: 'memory_reconciled',
        subject: memory.id,
        memoryId: memory.id,
        sourceReferences: [reference('memory', memory.id)],
      });
    }
    for (const memoryId of input.memoryAssessment.ignoredIds) {
      const stale = input.memoryAssessment.staleIds.includes(memoryId);
      const conflict = input.memoryAssessment.conflictingIds.includes(memoryId);
      this.add({
        requestId: input.requestId,
        category: 'memory',
        outcome: stale ? 'ignored_stale' : conflict ? 'ignored_conflict' : 'irrelevant',
        reasonCode: stale
          ? 'memory_stale'
          : conflict
            ? 'memory_conflicts_with_evidence'
            : 'memory_irrelevant',
        subject: memoryId,
        memoryId,
        sourceReferences: [reference('memory', memoryId)],
      });
    }

    for (const event of input.lifecycle.filter((entry) => entry.to === 'offloaded')) {
      const itemId = event.itemId ?? `request:${input.requestId}`;
      this.add({
        requestId: input.requestId,
        category: 'overflow',
        outcome: 'offloaded',
        reasonCode: 'context_offloaded',
        subject: itemId,
        sourceReferences: [reference('context_item', itemId)],
      });
    }
    for (const itemId of input.finalized.omittedItemIds) {
      this.add({
        requestId: input.requestId,
        category: 'overflow',
        outcome: 'omitted',
        reasonCode: 'item_omitted_by_budget',
        subject: itemId,
        sourceReferences: [reference('context_item', itemId)],
      });
    }
    if (input.finalized.omittedMessageIds.length > 0) {
      this.add({
        requestId: input.requestId,
        category: 'overflow',
        outcome: 'omitted',
        reasonCode: 'messages_omitted_by_budget',
        subject: `messages:${stableHash(input.finalized.omittedMessageIds)}`,
        sourceReferences: [reference('finalization', input.requestId)],
      });
    }

    if (
      !input.directive.continueToModel &&
      input.directive.decision !== 'RETRIEVE' &&
      input.directive.decision !== 'RETRIEVE_AGAIN'
    ) {
      const reasonCodes = input.directive.reasonCodes.length
        ? input.directive.reasonCodes
        : [`decision_${input.directive.decision.toLowerCase()}`];
      for (const reasonCode of reasonCodes) {
        this.add({
          requestId: input.requestId,
          category: 'quality_gate',
          outcome: 'rejected',
          reasonCode: boundedCode(reasonCode),
          subject: `${input.directive.decision}:${reasonCode}`,
          sourceReferences: [
            reference(
              'quality_decision',
              `${input.requestId}:${input.directive.decision}`,
            ),
          ],
        });
      }
    }

    return this.forRequest(input.requestId);
  }

  recordMemoryAdmission(
    requestId: string,
    memoryId: string,
    action: 'approve' | 'reject' | 'update' | 'supersede' | 'merge',
  ): ContextFeedbackRecord {
    return this.add({
      requestId,
      category: 'memory',
      outcome: action === 'reject' ? 'rejected' : 'retained',
      reasonCode: `memory_admission_${action}`,
      subject: `${memoryId}:${action}`,
      memoryId,
      sourceReferences: [reference('memory', memoryId)],
    });
  }

  forRequest(requestId: string): readonly ContextFeedbackRecord[] {
    return this.records
      .filter((record) => record.requestId === requestId)
      .map((record) => structuredClone(record));
  }

  snapshot(): readonly ContextFeedbackRecord[] {
    return this.records.map((record) => structuredClone(record));
  }

  private add(candidate: FeedbackCandidate): ContextFeedbackRecord {
    const sourceReferences = dedupeReferences(candidate.sourceReferences ?? []).slice(
      0,
      this.maximumSourceReferences,
    );
    const fingerprint = stableHash({
      requestId: candidate.requestId,
      category: candidate.category,
      outcome: candidate.outcome,
      reasonCode: candidate.reasonCode,
      subject: candidate.subject,
    });
    const record: ContextFeedbackRecord = {
      id: `feedback:${fingerprint}`,
      requestId: candidate.requestId,
      category: candidate.category,
      outcome: candidate.outcome,
      reasonCode: boundedCode(candidate.reasonCode),
      ...(candidate.operationId === undefined ? {} : { operationId: candidate.operationId }),
      ...(candidate.observationId === undefined
        ? {}
        : { observationId: candidate.observationId }),
      ...(candidate.evidenceId === undefined ? {} : { evidenceId: candidate.evidenceId }),
      ...(candidate.retrievalResultId === undefined
        ? {}
        : { retrievalResultId: candidate.retrievalResultId }),
      ...(candidate.memoryId === undefined ? {} : { memoryId: candidate.memoryId }),
      ...(candidate.toolName === undefined ? {} : { toolName: candidate.toolName.slice(0, 200) }),
      ...(candidate.capability === undefined ? {} : { capability: candidate.capability }),
      sourceReferences,
      at: now(),
    };
    const existingIndex = this.records.findIndex((entry) => entry.id === record.id);
    if (existingIndex >= 0) {
      const existing = this.records[existingIndex]!;
      const refreshed = {
        ...existing,
        sourceReferences: dedupeReferences([
          ...existing.sourceReferences,
          ...sourceReferences,
        ]).slice(0, this.maximumSourceReferences),
      };
      this.records[existingIndex] = refreshed;
      return structuredClone(refreshed);
    }
    this.records.push(record);
    if (this.records.length > this.maximumRecords) {
      this.records.splice(0, this.records.length - this.maximumRecords);
    }
    return structuredClone(record);
  }
}

function classifyOperation(
  operation: RuntimeRetrievalOperation,
  evidence: EvidenceItem | undefined,
  rejection: FeedbackEvidenceRejection | undefined,
  issues: readonly ContextQualityIssue[],
  activeIds: ReadonlySet<string>,
  canonicalIds: ReadonlySet<string>,
): { outcome: ContextFeedbackOutcome; reasonCode: string } | undefined {
  if (operation.status === 'denied') {
    return { outcome: 'failed', reasonCode: operation.failureClassification ?? 'authorization_denied' };
  }
  if (operation.status === 'failed' || operation.status === 'empty') {
    return {
      outcome: 'failed',
      reasonCode: operation.failureClassification ?? `retrieval_${operation.status}`,
    };
  }
  if (evidence && activeIds.has(evidence.id)) {
    return { outcome: 'useful', reasonCode: 'selected_for_model' };
  }
  if (rejection) return classifyRejection(rejection.reasons);
  const issueClassification = classifyIssues(issues);
  if (issueClassification) return issueClassification;
  if (evidence && canonicalIds.has(evidence.id)) {
    return { outcome: 'retained', reasonCode: 'admitted_not_selected' };
  }
  if (evidence) return { outcome: 'rejected', reasonCode: 'not_admitted' };
  return undefined;
}

function classifyRejection(
  reasons: readonly string[],
): { outcome: ContextFeedbackOutcome; reasonCode: string } {
  const normalized = reasons.join(' ').toLowerCase();
  if (/duplicate/.test(normalized)) return { outcome: 'duplicate', reasonCode: 'duplicate_evidence' };
  if (/relev|scope|poison/.test(normalized)) {
    return { outcome: 'irrelevant', reasonCode: 'evidence_rejected_irrelevant' };
  }
  if (/stale|fresh/.test(normalized)) return { outcome: 'rejected', reasonCode: 'evidence_rejected_stale' };
  if (/budget|token|count/.test(normalized)) return { outcome: 'rejected', reasonCode: 'evidence_budget_rejection' };
  if (/provenance/.test(normalized)) return { outcome: 'rejected', reasonCode: 'evidence_missing_provenance' };
  return { outcome: 'rejected', reasonCode: 'evidence_quality_rejection' };
}

function classifyIssues(
  issues: readonly ContextQualityIssue[],
): { outcome: ContextFeedbackOutcome; reasonCode: string } | undefined {
  if (issues.some((issue) => issue.code === 'duplicate')) {
    return { outcome: 'duplicate', reasonCode: 'quality_duplicate' };
  }
  if (issues.some((issue) => issue.code === 'irrelevant' || issue.code === 'out_of_scope')) {
    return { outcome: 'irrelevant', reasonCode: 'quality_irrelevant' };
  }
  if (issues.some((issue) => issue.code === 'stale')) {
    return { outcome: 'rejected', reasonCode: 'quality_stale' };
  }
  if (issues.some((issue) => issue.code === 'conflict')) {
    return { outcome: 'rejected', reasonCode: 'quality_conflict' };
  }
  if (issues.some((issue) => issue.code === 'budget' || issue.code === 'oversized')) {
    return { outcome: 'rejected', reasonCode: 'quality_budget' };
  }
  return undefined;
}

function issuesByItem(
  issues: readonly ContextQualityIssue[],
): ReadonlyMap<string, readonly ContextQualityIssue[]> {
  const byItem = new Map<string, ContextQualityIssue[]>();
  for (const issue of issues) {
    for (const itemId of issue.itemIds) {
      const entries = byItem.get(itemId) ?? [];
      entries.push(issue);
      byItem.set(itemId, entries);
    }
  }
  return byItem;
}

function reference(
  kind: ContextFeedbackReference['kind'],
  id: string,
): ContextFeedbackReference {
  return { kind, id: id.slice(0, 500) };
}

function dedupeReferences(
  references: readonly ContextFeedbackReference[],
): ContextFeedbackReference[] {
  const values = new Map<string, ContextFeedbackReference>();
  for (const entry of references) values.set(`${entry.kind}:${entry.id}`, entry);
  return [...values.values()];
}

function boundedCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unspecified'
  );
}
