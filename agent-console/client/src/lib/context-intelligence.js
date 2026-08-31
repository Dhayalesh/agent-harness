const QUALITY = {
  passed: {
    label: "Context ready",
    color: "success",
    detail: "The selected context passed the quality gate.",
  },
  degraded: {
    label: "Context degraded",
    color: "warning",
    detail: "The run continued with one or more context quality warnings.",
  },
  insufficient: {
    label: "Evidence insufficient",
    color: "warning",
    detail: "The available context did not fully support the request.",
  },
  rejected: {
    label: "Context rejected",
    color: "danger",
    detail: "The context quality gate rejected the selected material.",
  },
};

export const BUDGET_LABELS = {
  systemInstructions: "System instructions",
  taskInstructions: "Task instructions",
  userRequest: "User request",
  conversationHistory: "Conversation",
  memory: "Memory",
  retrievalEvidence: "Retrieved evidence",
  toolObservations: "Tool observations",
  taskState: "Task state",
  safetyPolicy: "Safety policy",
};

export function qualityPresentation(report) {
  const status = report?.quality?.status;
  return (
    QUALITY[status] ?? {
      label: "Context report",
      color: "default",
      detail: "The runtime reported Context Intelligence decisions.",
    }
  );
}

export function qualityScore(report) {
  const value = Number(report?.quality?.score);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export function budgetPercent(value) {
  const used = Number(value?.usedTokens);
  const maximum = Number(value?.maximumTokens);
  if (!Number.isFinite(used) || !Number.isFinite(maximum) || maximum <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / maximum) * 100)));
}

export function budgetRows(report) {
  const allocations = report?.budget?.allocations;
  if (!Array.isArray(allocations)) return [];
  return allocations
    .filter(
      (entry) =>
        entry &&
        typeof entry.category === "string" &&
        Number.isFinite(Number(entry.maximumTokens)),
    )
    .map((entry) => ({
      ...entry,
      label: BUDGET_LABELS[entry.category] ?? humanize(entry.category),
      percent: budgetPercent(entry),
    }));
}

export function reportStats(report) {
  if (!report) return [];
  return [
    {
      label: "Input selected",
      value: tokenCount(report.budget?.usedInput),
      detail: `${budgetUsePercent(report)}% of available input`,
    },
    {
      label: "Evidence",
      value: count(report.finalContext?.evidence),
      detail: `${count(report.finalContext?.sources)} sources`,
    },
    {
      label: "Retrieval",
      value: count(report.retrieval?.results),
      detail: `${count(report.retrieval?.iterations)} iterations`,
    },
    {
      label: "Tools exposed",
      value: count(report.capabilities?.selected),
      detail: `${count(report.capabilities?.available)} available`,
    },
  ];
}

export function issueSummary(report) {
  const issues = Array.isArray(report?.quality?.issues)
    ? report.quality.issues
    : [];
  const byKey = new Map();
  for (const issue of issues) {
    if (!issue?.code) continue;
    const key = `${issue.code}:${issue.severity ?? "info"}:${issue.remediation ?? "retain"}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      code: issue.code,
      label: humanize(issue.code),
      severity: issue.severity ?? "info",
      remediation: issue.remediation ?? "retain",
      items: (existing?.items ?? 0) + (Number(issue.items) || 0),
      occurrences: (existing?.occurrences ?? 0) + 1,
    });
  }
  return [...byKey.values()];
}

export function humanize(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function budgetUsePercent(report) {
  const used = Number(report?.budget?.usedInput);
  const available = Number(report?.budget?.availableInput);
  if (!Number.isFinite(used) || !Number.isFinite(available) || available <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((used / available) * 100));
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function tokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return number.toLocaleString();
}
