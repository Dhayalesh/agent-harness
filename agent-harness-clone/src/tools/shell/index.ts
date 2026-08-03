/**
 * Shell command safety layer shared by the `bash` and `powershell` tools.
 *
 * Ported from the helper modules that sit beside `BashTool` and `PowerShellTool`
 * in claude-code. The harness keeps them in one place because both tools need
 * the same workspace-boundary and destructive-command checks, and because a
 * future SAP-specific execution tool should reuse them rather than reimplement.
 */

import type { ToolPermissionCheck } from '../tool.js';
import { inspectBashCommand } from './bash-safety.js';
import { type ShellFinding, formatFindings, worstSeverity } from './findings.js';
import { inspectCommandPaths, type PathSafetyOptions } from './path-safety.js';
import { assessPowerShellReadOnly, inspectPowerShellCommand } from './powershell-safety.js';
import { assessReadOnly } from './read-only.js';
import { getDestructiveCommandWarning, type ShellFlavor } from './destructive-warning.js';

export type ShellPermissionOptions = PathSafetyOptions & {
  /**
   * When true, a command classified as read-only is auto-approved. Mirrors
   * claude-code's read-only fast path. Defaults to true.
   */
  autoApproveReadOnly?: boolean;
};

/**
 * Turns command inspection into a `ToolPermissionCheck`.
 *
 * Decision order, matching claude-code's validator chain precedence:
 *  1. any `block` finding -> deny (no rule or mode can override a tool deny)
 *  2. any `ask` finding -> ask, with all findings listed
 *  3. read-only command -> allow
 *  4. otherwise -> ask
 *
 * Destructive-command warnings never change the decision; they ride along on the
 * prompt so the user sees why the command is risky.
 */
export function evaluateShellCommand(
  command: string,
  flavor: ShellFlavor,
  options: ShellPermissionOptions,
): ToolPermissionCheck {
  const findings: ShellFinding[] = [];
  let readOnly = false;
  let readOnlyReason: string | undefined;

  if (flavor === 'bash') {
    const inspection = inspectBashCommand(command);
    findings.push(...inspection.findings);
    findings.push(...inspectCommandPaths(inspection.parsed, command, options));
    const assessment = assessReadOnly(command, inspection.parsed);
    readOnly = assessment.readOnly;
    readOnlyReason = assessment.reason;
  } else {
    const inspection = inspectPowerShellCommand(command);
    findings.push(...inspection.findings);
    const assessment = assessPowerShellReadOnly(command, inspection.stages);
    readOnly = assessment.readOnly;
    readOnlyReason = assessment.reason;
  }

  const warning = getDestructiveCommandWarning(command, flavor);
  const severity = worstSeverity(findings);

  if (severity === 'block') {
    const blocking = findings.filter((finding) => finding.severity === 'block');
    return {
      decision: 'deny',
      reason: `Command blocked by shell safety checks — ${formatFindings(blocking)}`,
    };
  }

  if (severity === 'ask') {
    return {
      decision: 'ask',
      reason: formatFindings(findings.filter((finding) => finding.severity !== 'warn')),
      ...(warning === null ? {} : { warning }),
    };
  }

  if (readOnly && options.autoApproveReadOnly !== false) {
    return { decision: 'allow', reason: 'Command is read-only' };
  }

  return {
    decision: 'ask',
    reason: readOnlyReason ?? 'Command can modify state',
    ...(warning === null ? {} : { warning }),
  };
}

export { inspectBashCommand, hasUnescapedChar, stripQuotedContent } from './bash-safety.js';
export {
  containsDirectoryChange,
  extractOutputRedirections,
  parseCommand,
  splitCommandSegments,
  stripSafeWrappers,
  tokenize,
} from './command-semantics.js';
export type { CommandSegment, ParsedCommand, Redirection } from './command-semantics.js';
export { getDestructiveCommandWarning } from './destructive-warning.js';
export type { ShellFlavor } from './destructive-warning.js';
export { findingsOfSeverity, formatFindings, worstSeverity } from './findings.js';
export type { FindingSeverity, ShellFinding } from './findings.js';
export { expandTilde, inspectCommandPaths, isDangerousRemovalPath } from './path-safety.js';
export type { FileOperationType, PathSafetyOptions } from './path-safety.js';
export {
  assessPowerShellReadOnly,
  inspectPowerShellCommand,
  splitPipeline,
} from './powershell-safety.js';
export type { PowerShellInspection, PowerShellReadOnlyAssessment } from './powershell-safety.js';
export { assessReadOnly } from './read-only.js';
export type { ReadOnlyAssessment } from './read-only.js';
