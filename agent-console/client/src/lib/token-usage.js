const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "estimatedCostUsd",
];

/** Total model tokens. Cache and reasoning figures are subsets, not extra tokens. */
export function tokenTotal(usage) {
  if (!usage) return 0;
  return (
    Number(usage.totalTokens) ||
    (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
  );
}

export function hasTokenUsage(usage) {
  return TOKEN_FIELDS.some(
    (field) => Number.isFinite(usage?.[field]) && usage[field] > 0,
  );
}

/** Adds provider usage records without treating subset fields as additional tokens. */
export function addTokenUsage(current, addition) {
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const left = Number.isFinite(current?.[field]) ? current[field] : 0;
    const right = Number.isFinite(addition?.[field]) ? addition[field] : 0;
    if (left || right || field === "inputTokens" || field === "outputTokens") {
      result[field] = left + right;
    }
  }
  result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  return result;
}

/**
 * Adds metadata or usage to one streamed model request while retaining arrival order.
 */
export function upsertUsageDetail(details, patch) {
  if (!patch?.turnId) return details ?? [];
  const all = Array.isArray(details) ? details : [];
  const index = all.findIndex((entry) => entry.turnId === patch.turnId);
  const current =
    index === -1 ? { turnId: patch.turnId, toolCallIds: [] } : all[index];
  const toolCallIds = [
    ...(current.toolCallIds ?? []),
    ...(patch.toolCallId ? [patch.toolCallId] : []),
  ].filter((id, itemIndex, values) => id && values.indexOf(id) === itemIndex);
  const updated = {
    ...current,
    ...(Number.isInteger(patch.turn) ? { turn: patch.turn } : {}),
    toolCallIds,
    ...(patch.usage
      ? { usage: addTokenUsage(current.usage, patch.usage) }
      : {}),
  };
  if (index === -1) return [...all, updated];
  return all.map((entry, entryIndex) =>
    entryIndex === index ? updated : entry,
  );
}

export function usageForTool(tool, details) {
  if (hasTokenUsage(tool?.usage)) {
    return {
      usage: tool.usage,
      turn: tool.usageTurn,
      sharedAcross: tool.usageSharedAcross ?? 1,
    };
  }
  const detail = (Array.isArray(details) ? details : []).find(
    (entry) =>
      entry?.turnId === tool?.turnId ||
      entry?.toolCallIds?.includes(tool?.id ?? tool?.key),
  );
  if (!hasTokenUsage(detail?.usage)) return null;
  return {
    usage: detail.usage,
    turn: detail.turn,
    sharedAcross: Math.max(1, detail.toolCallIds?.length ?? 1),
  };
}
