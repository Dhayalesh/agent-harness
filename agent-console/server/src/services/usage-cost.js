const MILLION = 1_000_000;

/**
 * Adds a cost ledger to a runtime result without replacing provider-reported cost.
 * The result remains the one object used by run persistence and chat persistence,
 * so those two views cannot drift.
 */
export function applyUsageCost(result, {
  pricing,
  modelProviderId,
  modelProviderName,
  provider,
  model,
  calculatedAt = new Date().toISOString(),
}) {
  if (!result?.usage) return result;

  const matchingPricing = pricing?.model === model ? pricing : undefined;
  if (matchingPricing && Array.isArray(result.usageDetails)) {
    for (const detail of result.usageDetails) {
      if (!detail?.usage || Number.isFinite(detail.usage.estimatedCostUsd)) continue;
      const priced = calculateUsageCost(detail.usage, matchingPricing, {
        requestCount: 1,
      });
      detail.usage.estimatedCostUsd = priced.totalUsd;
    }
  }
  if (matchingPricing && Array.isArray(result.toolCalls)) {
    for (const call of result.toolCalls) {
      if (!call?.usage || Number.isFinite(call.usage.estimatedCostUsd)) continue;
      call.usage.estimatedCostUsd = calculateUsageCost(
        call.usage,
        matchingPricing,
        { requestCount: 1 },
      ).totalUsd;
    }
  }

  const reported = finite(result.usage.estimatedCostUsd);
  const requestCount = Math.max(
    1,
    result.usageDetails?.filter((detail) => detail?.usage).length ||
      Number(result.turns) ||
      1,
  );
  const calculated = matchingPricing
    ? calculateUsageCost(result.usage, matchingPricing, { requestCount })
    : undefined;
  const totalUsd = reported ?? calculated?.totalUsd;
  if (totalUsd === undefined) return result;

  result.usage.estimatedCostUsd = totalUsd;
  result.cost = compact({
    currency: "USD",
    totalUsd,
    // A provider total is the billing authority. Locally calculated components
    // remain useful diagnostics, but are not forced to add up to that authority.
    inputUsd: calculated?.inputUsd,
    outputUsd: calculated?.outputUsd,
    cacheReadUsd: calculated?.cacheReadUsd,
    cacheWriteUsd: calculated?.cacheWriteUsd,
    reasoningUsd: calculated?.reasoningUsd,
    requestUsd: calculated?.requestUsd,
    requestCount,
    source: reported === undefined ? "catalog-estimate" : "provider-reported",
    estimated: reported === undefined,
    modelProviderId,
    modelProviderName,
    provider,
    model,
    pricing: matchingPricing ? { ...matchingPricing } : undefined,
    calculatedAt,
  });
  return result;
}

/** Calculates charge components while treating cache/reasoning counters as subsets. */
export function calculateUsageCost(usage, pricing, { requestCount = 1 } = {}) {
  const inputTokens = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  const cacheReadTokens = Math.min(inputTokens, count(usage?.cacheReadTokens));
  const remainingAfterRead =
    pricing.cacheReadPerMillionTokens === undefined
      ? inputTokens
      : inputTokens - cacheReadTokens;
  const cacheWriteTokens = Math.min(
    remainingAfterRead,
    count(usage?.cacheWriteTokens),
  );
  const standardInputTokens = Math.max(
    0,
    remainingAfterRead -
      (pricing.cacheWritePerMillionTokens === undefined ? 0 : cacheWriteTokens),
  );

  const reasoningTokens = Math.min(outputTokens, count(usage?.reasoningTokens));
  const standardOutputTokens =
    pricing.reasoningPerMillionTokens === undefined
      ? outputTokens
      : outputTokens - reasoningTokens;

  const inputUsd = charge(
    standardInputTokens,
    pricing.inputPerMillionTokens,
  );
  const outputUsd = charge(
    standardOutputTokens,
    pricing.outputPerMillionTokens,
  );
  const cacheReadUsd =
    pricing.cacheReadPerMillionTokens === undefined
      ? undefined
      : charge(cacheReadTokens, pricing.cacheReadPerMillionTokens);
  const cacheWriteUsd =
    pricing.cacheWritePerMillionTokens === undefined
      ? undefined
      : charge(cacheWriteTokens, pricing.cacheWritePerMillionTokens);
  const reasoningUsd =
    pricing.reasoningPerMillionTokens === undefined
      ? undefined
      : charge(reasoningTokens, pricing.reasoningPerMillionTokens);
  const requestUsd =
    pricing.requestUsd === undefined
      ? undefined
      : money(count(requestCount) * pricing.requestUsd);
  const totalUsd = money(
    [
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      reasoningUsd,
      requestUsd,
    ].reduce((total, value) => total + (value ?? 0), 0),
  );

  return compact({
    totalUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    reasoningUsd,
    requestUsd,
  });
}

function charge(tokens, perMillion) {
  return money((tokens * perMillion) / MILLION);
}

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

function finite(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Keep sub-cent LLM charges useful while eliminating binary floating-point tails.
function money(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
