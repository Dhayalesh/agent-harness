/**
 * Shared finding vocabulary for the shell safety validators.
 *
 * `claude-code` returns `PermissionResult` objects (`allow` / `ask` / `deny` /
 * `passthrough`) from a long validator chain. The harness keeps the same shape
 * but names it after what it is: a list of findings, each carrying the severity
 * it justifies. `worstSeverity` collapses them the way the validator chain's
 * short-circuit did.
 */

export type FindingSeverity = 'block' | 'ask' | 'warn';

export type ShellFinding = {
  severity: FindingSeverity;
  /** Stable identifier, useful for tests and audit logs. */
  code: string;
  message: string;
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = { warn: 0, ask: 1, block: 2 };

export function worstSeverity(findings: readonly ShellFinding[]): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const finding of findings) {
    if (worst === undefined || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst]) {
      worst = finding.severity;
    }
  }
  return worst;
}

export function findingsOfSeverity(
  findings: readonly ShellFinding[],
  severity: FindingSeverity,
): ShellFinding[] {
  return findings.filter((finding) => finding.severity === severity);
}

export function formatFindings(findings: readonly ShellFinding[]): string {
  return findings.map((finding) => `${finding.code}: ${finding.message}`).join('; ');
}
