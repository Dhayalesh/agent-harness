import { AgentHarnessError } from '../core/errors.js';
import type { AgentRecordLimits, AgentSkill } from './agent-definitions.js';

/**
 * What the runtime honours *today*.
 *
 * The `agents` schema stores names, and a name is only worth storing if this
 * runtime can hand the thing back. To keep the difference from becoming a silent
 * drop, every create and update is validated against this table and rejected when
 * it names something the runtime would ignore.
 *
 * When a tool is added or removed, this file is the only thing that changes.
 */
export const AGENT_RUNTIME_SUPPORT = {
  /**
   * Every local tool a host can offer, by the `name` each factory sets.
   *
   * - builtin (`src/tools/builtin/index.ts`): `read_file`, `glob`, `grep`,
   *   `write_file`, `edit_file`, response artifact tools, `bash`, `powershell`, `todo_write`
   * - web (`src/tools/web/index.ts`): `web_search`, `web_fetch`, `browser_use`
   *
   * The plan-mode and `ask_user_question` tools are deliberately absent. Both need
   * someone watching: plan mode is a review step before a human approves, and a
   * question suspends the turn until one is answered. A payload is answered by
   * nobody, so offering either would produce a run that stalls or that silently
   * picks an option on the caller's behalf.
   *
   * A host need not offer all of these: `powershell` is gated on the platform, and
   * `web_search` needs a search credential. Membership here means the name is
   * spelled correctly, not that the running host has it; resolution checks the
   * host's actual set and reports what is missing.
   */
  tools: [
    'read_file',
    'glob',
    'grep',
    'write_file',
    'edit_file',
    'create_markdown_artifact',
    'create_html_artifact',
    'create_document_artifact',
    'create_spreadsheet_artifact',
    'create_csv_artifact',
    'create_json_artifact',
    'create_code_artifact',
    'bash',
    'powershell',
    'todo_write',
    'web_search',
    'web_fetch',
    'browser_use',
  ] as const,
  /**
   * Every stored limit is acted on: the three become `AgentSessionConfig.limits`
   * verbatim, and the session applies them per run
   * (`src/core/agent-session.ts`).
   */
  limitsHonoured: ['maxTurns', 'maxOutputTokens', 'compactionThresholdPercent'] as const,
  /**
   * Every other stored field is acted on too, which is why there is no ignored
   * list here as there is for `model_providers`: `systemPrompt` and `model` reach
   * `createAgentSession`, `modelProvider` selects the `model_providers` record,
   * `mcpServers` selects the `mcp_servers` records, and `skills` becomes a
   * `SkillRegistry` plus the `skill` tool.
   */
  fieldsHonoured: [
    'systemPrompt',
    'modelProvider',
    'model',
    'tools',
    'skills',
    'mcpServers',
    'limits',
  ] as const,
} as const;

/**
 * Tool names the record cannot list, because something else on the record
 * produces them. A value stored here would read as configuration that is not in
 * effect, or would be overwritten by the generated one.
 */
export const RESERVED_TOOL_NAMES = ['skill'] as const;

/**
 * MCP tools are named `mcp__<server>__<tool>` and both halves are normalized at
 * connect time (`src/mcp/client.ts`), so the final name is not known until the
 * server answers `listTools`.
 */
export const MCP_TOOL_PREFIX = 'mcp__';

export type SupportedAgentTool = (typeof AGENT_RUNTIME_SUPPORT.tools)[number];
export type HonouredAgentLimit = (typeof AGENT_RUNTIME_SUPPORT.limitsHonoured)[number];

/** The subset of a record the support gate inspects. */
export type AgentRuntimeSupportCheckInput = {
  tools: readonly string[];
  skills: readonly AgentSkill[];
  limits: AgentRecordLimits;
};

/**
 * Rejects any stored shape the runtime would ignore. Called on every create and
 * update, and again at resolution as defence in depth.
 */
export function assertAgentRuntimeSupport(record: AgentRuntimeSupportCheckInput): void {
  for (const tool of record.tools) assertSupportedTool(tool);
  // A skill's own `allowedTools` is gated where that record is written; what is
  // checked here is the per-agent override, which is stored on this record.
  for (const skill of record.skills) {
    for (const tool of skill.allowedTools ?? []) assertSupportedTool(tool, skill.skillId);
  }
  assertSupportedLimits(record.limits);
}

function assertSupportedTool(tool: string, skillId?: string): void {
  const where = skillId === undefined ? `tools '${tool}'` : `skill ${skillId} tool '${tool}'`;
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    throw new AgentHarnessError(
      `Unsupported ${where}: an MCP tool name is generated at connect time from the server's ` +
        'listTools answer (src/mcp/client.ts), so it cannot be listed in advance. ' +
        'Add the server to mcpServers instead; its tools are offered automatically.',
      'UNSUPPORTED_AGENT_TOOL',
    );
  }
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(tool)) {
    throw new AgentHarnessError(
      `Unsupported ${where}: the '${tool}' tool is built from this record's skills, so a ` +
        'listed one would be replaced by the generated tool. Populate skills instead.',
      'UNSUPPORTED_AGENT_TOOL',
    );
  }
  if (!(AGENT_RUNTIME_SUPPORT.tools as readonly string[]).includes(tool)) {
    throw new AgentHarnessError(
      `Unsupported ${where}: no tool by that name exists in this runtime. ` +
        `Supported: ${AGENT_RUNTIME_SUPPORT.tools.join(', ')}.`,
      'UNSUPPORTED_AGENT_TOOL',
    );
  }
}

/**
 * The two token fields are a budget split, so a session that reserved more for
 * the reply than the whole window allows would leave nothing to read. The
 * comparison only applies when the record sets both; when it sets neither,
 * resolution derives them from the model provider record and that record's own
 * schema already guarantees the ordering.
 */
function assertSupportedLimits(limits: AgentRecordLimits): void {
  for (const field of Object.keys(limits) as Array<keyof AgentRecordLimits>) {
    if (limits[field] === undefined) continue;
    if ((AGENT_RUNTIME_SUPPORT.limitsHonoured as readonly string[]).includes(field)) continue;
    throw new AgentHarnessError(
      `Unsupported field 'limits.${field}': the session applies only ` +
        `${AGENT_RUNTIME_SUPPORT.limitsHonoured.map((name) => `limits.${name}`).join(', ')}.`,
      'UNSUPPORTED_AGENT_LIMIT',
    );
  }
}
