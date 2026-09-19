import { createElement } from "react";

export function contextPercent(context) {
  const value = Number(context?.usedPercent);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

/** Customer-facing context UI: one authoritative percentage and one action. */
export function ContextIndicator({
  context,
  onCompact,
  compacting = false,
  disabled = false,
}) {
  const percent = contextPercent(context);
  if (percent === null) return null;

  return createElement(
    "div",
    {
      className: "flex items-center gap-2.5 text-tiny text-default-500",
      "aria-label": `Context ${percent}%`,
    },
    createElement(
      "span",
      { className: "whitespace-nowrap tabular-nums" },
      "Context ",
      createElement(
        "strong",
        { className: "font-medium text-foreground" },
        `${percent}%`,
      ),
    ),
    onCompact
      ? createElement(
          "button",
          {
            type: "button",
            className:
              "rounded-md px-1.5 py-0.5 font-medium text-primary outline-none transition-colors duration-200 hover:bg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-50",
            disabled: disabled || compacting,
            onClick: onCompact,
            "aria-busy": compacting || undefined,
          },
          compacting ? "Compacting…" : "Compact",
        )
      : null,
  );
}
