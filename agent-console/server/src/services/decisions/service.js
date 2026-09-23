/** Backend-neutral selection policy. Backend scores never authorize new IDs. */
export async function decide(request, { backend, config, signal }) {
  const {
    options,
    selectionMode = "multiple",
    threshold,
    maxSelections,
  } = request;
  if (!["single", "multiple"].includes(selectionMode))
    throw new Error("INVALID_MODE");
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isInteger(maxSelections) ||
    maxSelections < 1
  )
    throw new Error("INVALID_POLICY");
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length || options.length > 100)
    throw new Error("INVALID_OPTIONS");
  if (!options.length)
    return { status: "no_match", selectedIds: [], scores: [] };
  const scores = await backend.score(request, config, signal);
  if (!Array.isArray(scores) || scores.length !== options.length)
    throw new Error("INVALID_SCORES");
  const seen = new Set();
  for (const item of scores) {
    if (
      !item ||
      !ids.has(item.id) ||
      seen.has(item.id) ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > 1
    ) {
      throw new Error("INVALID_SCORES");
    }
    seen.add(item.id);
  }
  const ranked = [...scores].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  const matches = ranked.filter((item) => item.score >= threshold);
  const limit = selectionMode === "single" ? 1 : maxSelections;
  // Do not silently remove part of a compound workflow.
  if (selectionMode === "multiple" && matches.length > limit)
    throw new Error("TOO_MANY_MATCHES");
  const selectedIds = matches.slice(0, limit).map((item) => item.id);
  return {
    status: selectedIds.length ? "selected" : "no_match",
    selectedIds,
    scores: ranked,
  };
}
