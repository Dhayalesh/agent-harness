import type { AgentMessage } from '../core/messages.js';
import type {
  ContextContract,
  EvidenceItem,
  GroundingAssessment,
  GroundingEvidenceReference,
  RuntimeRetrievalOperation,
} from './contracts.js';
import { dedupeStrings, now, stableHash, uniqueTerms } from './utils.js';

/**
 * Verifies a terminal model answer against evidence produced by this request's
 * actual successful retrieval operations. Plans, model tool requests, failed
 * operations, and observations without invocation/result receipts are excluded.
 */
export function evaluateGrounding(
  contract: ContextContract,
  message: AgentMessage,
): GroundingAssessment {
  const required = contract.contextNeeds.some(
    (need) => need.required && need.evidenceRequirement === 'REQUIRED',
  );
  if (!required) {
    return {
      status: 'NOT_REQUIRED',
      required: false,
      decision: 'ACCEPT',
      claimCount: 0,
      supportedClaimCount: 0,
      unsupportedClaimIds: [],
      claims: [],
      supportingEvidenceReferences: [],
      reasonCodes: [],
      checkedAt: now(),
    };
  }
  if (message.content.some((block) => block.type === 'tool_call')) {
    return {
      status: 'NOT_EVALUATED',
      required: true,
      claimCount: 0,
      supportedClaimCount: 0,
      unsupportedClaimIds: [],
      claims: [],
      supportingEvidenceReferences: [],
      reasonCodes: ['non_terminal_model_tool_request'],
    };
  }

  const eligible = eligibleRuntimeEvidence(contract);
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const extracted = answerClaims(text);
  const claims = extracted.values.map((claim) => {
    const references = eligible
      .filter(({ evidence }) => supportsClaim(claim, evidence))
      .map(({ reference }) => reference);
    return {
      claimId: `claim:${stableHash(claim)}`,
      claim,
      supported: references.length > 0,
      evidenceReferences: references,
    };
  });
  const unsupportedClaimIds = claims
    .filter((claim) => !claim.supported)
    .map((claim) => claim.claimId);
  const supportingEvidenceReferences = dedupeReferences(
    claims.flatMap((claim) => claim.evidenceReferences),
  );
  const passed = claims.length > 0 && !extracted.truncated && unsupportedClaimIds.length === 0;
  return {
    status: passed ? 'PASS' : 'FAIL',
    required: true,
    decision: passed ? 'ACCEPT' : 'ABSTAIN',
    claimCount: claims.length,
    supportedClaimCount: claims.length - unsupportedClaimIds.length,
    unsupportedClaimIds,
    claims,
    ...(extracted.truncated ? { claimsTruncated: true } : {}),
    supportingEvidenceReferences,
    reasonCodes: passed
      ? ['all_answer_claims_supported_by_runtime_evidence']
      : dedupeStrings([
          ...(claims.length === 0 ? ['no_groundable_answer_claims'] : []),
          ...(eligible.length === 0 ? ['no_successful_runtime_evidence'] : []),
          ...(unsupportedClaimIds.length > 0 ? ['unsupported_answer_claims'] : []),
          ...(extracted.truncated ? ['grounding_claim_limit_exceeded'] : []),
        ]),
    checkedAt: now(),
  };
}

function eligibleRuntimeEvidence(contract: ContextContract): Array<{
  evidence: EvidenceItem;
  operation: RuntimeRetrievalOperation;
  reference: GroundingEvidenceReference;
}> {
  const values: Array<{
    evidence: EvidenceItem;
    operation: RuntimeRetrievalOperation;
    reference: GroundingEvidenceReference;
  }> = [];
  for (const evidence of contract.evidence) {
    if (!evidence.evaluation.admitted || !evidence.observationId) continue;
    const operation = contract.runtimeRetrieval.find(
      (candidate) => candidate.observationId === evidence.observationId,
    );
    if (!isSuccessfulRuntimeOperation(operation)) continue;
    const observation = contract.observations.find(
      (candidate) => candidate.id === evidence.observationId,
    );
    if (
      !observation ||
      (observation.outcome !== 'success' && observation.outcome !== 'partial') ||
      observation.content.trim().length === 0 ||
      evidence.provenance.id.length === 0 ||
      (['web', 'external'].includes(evidence.source.type) && !evidence.source.uri)
    ) {
      continue;
    }
    values.push({
      evidence,
      operation,
      reference: {
        evidenceId: evidence.id,
        observationId: observation.id,
        operationId: operation.id,
        provenanceId: evidence.provenance.id,
        sourceId: evidence.source.id,
        sourceName: evidence.source.name,
        ...(evidence.source.uri === undefined ? {} : { sourceUri: evidence.source.uri }),
      },
    });
  }
  return values;
}

function isSuccessfulRuntimeOperation(
  operation: RuntimeRetrievalOperation | undefined,
): operation is RuntimeRetrievalOperation {
  return Boolean(
    operation &&
    operation.status === 'succeeded' &&
    operation.executionState === 'SUCCESS' &&
    operation.invokedAt !== undefined &&
    operation.actualInput !== undefined &&
    operation.actualResult !== undefined &&
    operation.actualResult.isError !== true &&
    operation.resultReceivedAt !== undefined &&
    operation.observationId !== undefined,
  );
}

const MAX_GROUNDING_CLAIMS = 100;

function answerClaims(text: string): { values: string[]; truncated: boolean } {
  const values: string[] = [];
  const seen = new Set<string>();
  const candidates = text
    .replace(/```[A-Za-z0-9_-]*/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#+\s*)/, '').trim())
    .filter((line) => line.length > 0 && uniqueTerms(line).length > 0);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (values.length === MAX_GROUNDING_CLAIMS) {
      return { values, truncated: true };
    }
    values.push(candidate);
  }
  return { values, truncated: false };
}

function supportsClaim(claim: string, evidence: EvidenceItem): boolean {
  if (evidence.relationship === 'contradicts') return false;
  return evidenceSegments(evidence).some((segment) => supportsEvidenceSegment(claim, segment));
}

function evidenceSegments(evidence: EvidenceItem): string[] {
  return dedupeStrings(
    [evidence.content, ...evidence.claims]
      .flatMap((value) => value.split(/(?<=[.!?])\s+|\n+/))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function supportsEvidenceSegment(claim: string, segment: string): boolean {
  const normalizedClaim = normalize(claim);
  const normalizedSegment = normalize(segment);
  if (
    normalizedClaim.length === 0 ||
    normalizedSegment.length === 0 ||
    hasPolarityMismatch(claim, segment) ||
    hasMaterialValueMismatch(claim, segment) ||
    hasEntityMismatch(claim, segment)
  ) {
    return false;
  }
  return normalizedSegment.includes(normalizedClaim);
}

const NEGATION =
  /\b(?:no|not|never|neither|without|cannot|can't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|wouldn't|shouldn't|mustn't|unable|lack|lacks|lacked|lacking|deny|denies|denied)\b/i;
const OPPOSING_TERMS = [
  ['available', 'unavailable'],
  ['enabled', 'disabled'],
  ['allowed', 'forbidden'],
  ['supported', 'unsupported'],
  ['success', 'failure'],
  ['succeeded', 'failed'],
  ['present', 'absent'],
  ['includes', 'excludes'],
  ['included', 'excluded'],
  ['provides', 'lacks'],
  ['has', 'lacks'],
  ['increase', 'decrease'],
  ['increased', 'decreased'],
  ['before', 'after'],
  ['true', 'false'],
] as const;

function hasPolarityMismatch(claim: string, segment: string): boolean {
  if (NEGATION.test(claim) !== NEGATION.test(segment)) return true;
  const claimTerms = new Set(uniqueTerms(claim).map((term) => term.toLowerCase()));
  const segmentTerms = new Set(uniqueTerms(segment).map((term) => term.toLowerCase()));
  return OPPOSING_TERMS.some(
    ([left, right]) =>
      (claimTerms.has(left) && segmentTerms.has(right)) ||
      (claimTerms.has(right) && segmentTerms.has(left)),
  );
}

function hasMaterialValueMismatch(claim: string, segment: string): boolean {
  const claimValues = materialValues(claim);
  if (claimValues.length === 0) return false;
  const segmentValues = new Set(materialValues(segment));
  return claimValues.some((value) => !segmentValues.has(value));
}

function materialValues(value: string): string[] {
  const numbers = [...value.matchAll(/(?<!\d)\d[\d,]*(?:\.\d+)*%?/g)].map((match) => match[0]);
  const quoted = [...value.matchAll(/["“”`]([^"“”`]{1,100})["“”`]/g)].map((match) => match[1]!);
  return dedupeStrings(
    [...numbers.map((entry) => entry.replace(/,/g, '')), ...quoted.map(normalize)].filter(Boolean),
  );
}

const ENTITY_STOPWORDS = new Set([
  'A',
  'An',
  'According',
  'As',
  'At',
  'Based',
  'Current',
  'For',
  'From',
  'In',
  'It',
  'Latest',
  'Official',
  'On',
  'That',
  'The',
  'These',
  'This',
  'Those',
]);

function hasEntityMismatch(claim: string, segment: string): boolean {
  const claimEntities = entityTerms(claim);
  if (claimEntities.length === 0) return false;
  const segmentEntities = new Set(entityTerms(segment).map((term) => term.toLowerCase()));
  const normalizedSegment = new Set(uniqueTerms(segment).map((term) => term.toLowerCase()));
  return claimEntities.some(
    (entity) =>
      !segmentEntities.has(entity.toLowerCase()) && !normalizedSegment.has(entity.toLowerCase()),
  );
}

function entityTerms(value: string): string[] {
  const matches = value.match(/\b[A-Za-z][A-Za-z0-9.-]*\b/g) ?? [];
  return dedupeStrings(
    matches.filter(
      (term) =>
        !ENTITY_STOPWORDS.has(term) &&
        (/^[A-Z]{2,}$/.test(term) || /[a-z][A-Z]/.test(term) || /^[A-Z][a-z]{2,}$/.test(term)),
    ),
  );
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeReferences(
  references: readonly GroundingEvidenceReference[],
): GroundingEvidenceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.evidenceId}:${reference.operationId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
