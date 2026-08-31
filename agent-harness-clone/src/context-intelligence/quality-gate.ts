import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextNeed,
  ContextQualityIssue,
  ContextQualityReport,
  ContextRuntimeAction,
  ContextRuntimeDirective,
  RuntimeRetrievalOperation,
} from './contracts.js';
import { clamp, dedupeStrings, now } from './utils.js';

/** Converts quality findings into an authoritative runtime directive. */
export class ContextQualityGate {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  evaluate(input: {
    report: ContextQualityReport;
    needs: readonly ContextNeed[];
    actions: readonly ContextRuntimeAction[];
    operations: readonly RuntimeRetrievalOperation[];
    elapsedMs: number;
  }): { report: ContextQualityReport; directive: ContextRuntimeDirective } {
    const missing = input.needs.filter((need) => need.required && need.status !== 'satisfied');
    const issues = [...input.report.issues, ...missing.map(issueForNeed)];
    const hardPolicyFailure = issues.some(
      (issue) =>
        issue.severity === 'error' &&
        (issue.code === 'policy' || issue.code === 'poisoning' || issue.code === 'out_of_scope'),
    );
    const clarification = missing.filter((need) => need.status === 'clarification_required');
    const unavailable = missing.filter((need) => need.status === 'unavailable');
    const unresolvedConflict = input.report.conflicts.some(
      (conflict) => conflict.resolution === 'unresolved',
    );
    const exhausted =
      input.elapsedMs >= this.config.budgets.maxLoopMilliseconds ||
      input.operations.length >= this.config.budgets.maxRetrievalOperations ||
      input.operations.length >= this.config.budgets.maxToolActions ||
      input.operations.reduce((maximum, operation) => Math.max(maximum, operation.iteration), 0) >=
        this.config.budgets.maxRetrievalIterations;

    const decision = hardPolicyFailure
      ? ('DENY' as const)
      : input.actions.length > 0
        ? ('RETRIEVE' as const)
        : clarification.length > 0
          ? ('CLARIFY' as const)
          : unavailable.length > 0
            ? this.config.quality.unavailablePolicy === 'clarify'
              ? ('CLARIFY' as const)
              : ('ABSTAIN' as const)
            : unresolvedConflict
              ? ('CONFLICT' as const)
              : missing.length > 0
                ? ('ABSTAIN' as const)
                : ('ACCEPT' as const);
    const continueToModel =
      decision === 'ACCEPT' ||
      (decision === 'CONFLICT' && this.config.quality.conflictPolicy === 'proceed');
    const status: ContextQualityReport['status'] =
      decision === 'DENY'
        ? 'rejected'
        : decision === 'ACCEPT'
          ? input.report.status === 'insufficient' &&
            !input.report.issues.some((issue) => issue.severity === 'error')
            ? 'passed'
            : input.report.status
          : decision === 'CONFLICT'
            ? 'degraded'
            : 'insufficient';
    const sufficient = decision === 'ACCEPT';
    const report: ContextQualityReport = {
      ...input.report,
      status,
      decision,
      score: qualityScore(input.report.score, decision, missing.length),
      issues: dedupeIssues(issues),
      sufficient,
      checkedAt: now(),
    };
    const reasonCodes = dedupeStrings([
      ...(hardPolicyFailure ? ['policy_denied'] : []),
      ...(input.actions.length > 0 ? ['retrieval_available'] : []),
      ...(clarification.length > 0 ? ['clarification_required'] : []),
      ...(unavailable.length > 0 ? ['capability_unavailable'] : []),
      ...(unresolvedConflict ? ['unresolved_conflict'] : []),
      ...(exhausted && missing.length > 0 ? ['retrieval_budget_exhausted'] : []),
      ...(missing.length > 0 ? ['required_evidence_missing'] : []),
    ]);
    return {
      report,
      directive: {
        decision,
        continueToModel,
        actions: input.actions,
        reasonCodes,
        clarification: clarification.map((need) => ({
          needId: need.id,
          type: need.type,
          missingInformation: need.missingInformation,
        })),
      },
    };
  }
}

function issueForNeed(need: ContextNeed): ContextQualityIssue {
  return {
    code: 'missing_evidence',
    severity: 'error',
    itemIds: [],
    message: `${need.type}: ${need.missingInformation.join(', ') || 'required information is missing'}.`,
    remediation:
      need.status === 'clarification_required'
        ? 'clarify'
        : need.status === 'unavailable'
          ? 'reject'
          : 'retrieve',
  };
}

function dedupeIssues(issues: readonly ContextQualityIssue[]): ContextQualityIssue[] {
  const values = new Map<string, ContextQualityIssue>();
  for (const issue of issues) {
    const key = `${issue.code}:${issue.severity}:${issue.remediation}:${issue.message}`;
    const existing = values.get(key);
    values.set(key, {
      ...issue,
      itemIds: dedupeStrings([...(existing?.itemIds ?? []), ...issue.itemIds]),
    });
  }
  return [...values.values()];
}

function qualityScore(
  base: number,
  decision: ContextQualityReport['decision'],
  missingNeeds: number,
): number {
  if (decision === 'ACCEPT') return clamp(base);
  if (decision === 'CONFLICT') return clamp(Math.min(base, 0.65));
  if (decision === 'DENY') return 0;
  return clamp(Math.min(base, Math.max(0, 0.45 - missingNeeds * 0.15)));
}
