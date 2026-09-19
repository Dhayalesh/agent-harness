import { forwardRef, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";
import { SkeletonText } from "./Skeleton.jsx";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * The console's one table.
 *
 * Built on a semantic `<table>` and driven by a column declaration, because the
 * things that make a data table feel like an instrument — a header that stays put
 * while the body scrolls, hairline rows, numerals that line up in their column,
 * actions that only appear on the row under the cursor — are layout decisions that
 * have to be made here rather than inside a generic table component.
 *
 * shadcn's Table primitives are the presentational layer for a table the caller
 * lays out by hand; this owns sorting, the sticky head, the skeleton and the row
 * link, so it composes the same elements directly.
 *
 * A column is declared once and drives everything:
 *
 *   {
 * key: unique id, also the sort key
 * header: column label
 * render:   (row) => node what the cell shows
 * value:    (row) => primitive what it sorts and filters by
 * sortable: boolean
 * align:    "left"| "right"* numeric: boolean tabular figures, right aligned by default
 * width:    CSS width for <col>
 * hideBelow: "sm"| "md"| "lg"| "xl"drop the column on small screens
 * primary: boolean the cell that carries the row's link
 *   }
 */

const HIDE_BELOW = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

const HIDE_COLUMN_BELOW = {
  sm: "hidden sm:table-column",
  md: "hidden md:table-column",
  lg: "hidden lg:table-column",
  xl: "hidden xl:table-column",
};

/**
 * Missing values sort last in both directions. Flipping them to the top on a
 * descending sort would bury the rows the user is actually looking for.
 */
function compareValues(a, b, type) {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (type === "number") return Number(a) - Number(b);
  if (type === "date") return new Date(a).getTime() - new Date(b).getTime();
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function DataTable({
  columns,
  rows,
  rowKey = (row) => row.id,
  to,
  actions,
  loading = false,
  skeletonRows = 6,
  empty = null,
  defaultSort = null,
  caption,
  total,
  totalLabel = "rows",
  maxHeight = "calc(100vh - 260px)",
  className = "",
}) {
  const [sort, setSort] = useState(defaultSort);

  const sorted = useMemo(() => {
    if (!rows || !sort) return rows;
    const column = columns.find((entry) => entry.key === sort.key);
    if (!column) return rows;
    const read = column.value ?? ((row) => row[column.key]);
    const type = column.sortType ?? (column.numeric ? "number" : "string");
    // Copy first: sorting the array the caller handed us would mutate their state.
    const next = [...rows].sort((a, b) =>
      compareValues(read(a), read(b), type),
    );
    return sort.dir === "desc" ? next.reverse() : next;
  }, [rows, sort, columns]);

  const toggleSort = (key) =>
    setSort((current) =>
      current?.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );

  const showEmpty = !loading && sorted && sorted.length === 0;
  const shownCount = sorted?.length ?? 0;

  return (
    <div
      aria-busy={loading}
      className={cn("overflow-hidden rounded-xl border border-divider bg-content1 shadow-sm", className)}
    >
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full min-w-[560px] table-fixed border-collapse text-small sm:min-w-0">
          {caption && <caption className="sr-only">{caption}</caption>}
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.key}
                style={{ width: column.width }}
                className={cn(
                  column.hideBelow && HIDE_COLUMN_BELOW[column.hideBelow],
                  column.primary && "max-sm:!w-[240px]",
                )}
              />
            ))}
            {actions && <col style={{ width: "120px" }} />}
          </colgroup>

          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const alignRight =
                  column.align === "right" ||
                  (column.numeric && column.align !== "left");
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : column.sortable
                          ? "none"
                          : undefined
                    }
                    className={cn(
                      "relative h-12 whitespace-nowrap border-b border-divider bg-content2 px-4 py-3 text-small font-semibold tracking-normal text-foreground align-middle",
                      alignRight ? "text-right" : "text-left",
                      active && "text-primary",
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                      column.headerClassName,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          "group/sort -mx-1 inline-flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors duration-200 hover:bg-primary/[0.08] hover:text-primary",
                          alignRight && "flex-row-reverse",
                        )}
                      >
                        {column.header}
                        <Icon
                          name={
                            !active
                              ? "sort"
                              : sort.dir === "asc"
                                ? "sortAsc"
                                : "sortDesc"
                          }
                          className={cn(
                            "h-3 w-3",
                            active
                              ? "text-primary"
                              : "text-default-400 group-hover/sort:text-primary",
                          )}
                          strokeWidth={2}
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {actions && (
                <th scope="col" className="border-b border-divider bg-content2">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {loading &&
              Array.from({ length: skeletonRows }).map((_, index) => (
                <tr
                  key={`skeleton-${index}`}
                  className="border-b border-divider"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "px-4 py-4",
                        column.hideBelow && HIDE_BELOW[column.hideBelow],
                      )}
                    >
                      {column.primary ? (
                        <div className="flex min-h-12 flex-col justify-center gap-2.5">
                          <SkeletonText className="w-2/3" />
                          <SkeletonText className="h-2.5 w-5/6" />
                        </div>
                      ) : (
                        <SkeletonText
                          className={column.numeric ? "ml-auto w-8" : "w-4/5"}
                        />
                      )}
                    </td>
                  ))}
                  {actions && <td />}
                </tr>
              ))}

            {!loading &&
              sorted?.map((row) => {
                const href = to?.(row);
                const rowActions = actions?.(row) ?? [];
                return (
                  <tr
                    key={rowKey(row)}
                    // A soft tint follows pointer and keyboard focus.
                    className="group relative border-b border-divider transition-colors duration-200 last:border-b-0 hover:bg-primary/[0.04] focus-within:bg-primary/[0.04]"
                  >
                    {columns.map((column) => {
                      const alignRight =
                        column.align === "right" ||
                        (column.numeric && column.align !== "left");
                      const content = column.render
                        ? column.render(row)
                        : (column.value?.(row) ?? row[column.key]);
                      return (
                        <td
                          key={column.key}
                          className={cn(
                            "break-words px-4 py-4 align-middle",
                            alignRight ? "text-right" : "text-left",
                            column.numeric &&
                              "text-small tabular-nums text-default-600",
                            column.hideBelow && HIDE_BELOW[column.hideBelow],
                            column.className,
                          )}
                        >
                          {/*
                            The row's link lives in the primary cell and stretches
 over the whole row with a pseudo-element. A <tr> cannot
 be a link, and wrapping every cell in one would put a
 dozen identical targets in the tab order.
                          */}
                          {column.primary && href ? (
                            <Link
                              to={href}
                              className="relative font-medium text-foreground outline-none after:absolute after:inset-0 after:z-0 after:content-[''] hover:text-primary focus-visible:underline group-hover:text-primary"
                            >
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}

                    {actions && (
                      <td className="px-3 py-4">
                        <div className="relative z-10 flex items-center justify-end gap-0.5">
                          {rowActions.map((action) =>
                            action.to ? (
                              <RowIconLink key={action.key} action={action} />
                            ) : (
                              <RowIconButton key={action.key} action={action} />
                            ),
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>

        {showEmpty && <div>{empty}</div>}
      </div>

      {/* A count is the cheapest way to tell a filtered view from an empty one. */}
      {!loading && !showEmpty && (
        <div className="flex items-center justify-between border-t border-divider bg-content2/60 px-4 py-3">
          <span className="text-tiny font-medium text-default-500">
            {shownCount.toLocaleString()}
            {total !== undefined && total !== shownCount
              ? ` / ${total.toLocaleString()}`
              : ""}{" "}
            {totalLabel}
          </span>
        </div>
      )}
    </div>
  );
}

/** Row actions remain visible for pointer, keyboard, and touch users. */
const ROW_ACTION_CLASS =
  "grid h-8 w-8 place-items-center rounded-md text-default-500 outline-none transition-colors duration-200 hover:bg-primary/[0.08] hover:text-primary focus-visible:ring-2 focus-visible:ring-focus";

function RowIconButton({ action }) {
  return (
    <Tooltip content={action.label} delayDuration={300}>
      <button
        type="button"
        aria-label={action.label}
        onClick={action.onClick}
        className={cn(
          ROW_ACTION_CLASS,
          action.tone === "danger" && "hover:bg-danger/10 hover:text-danger",
        )}
      >
        <Icon name={action.icon} className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

function RowIconLink({ action }) {
  return (
    <Tooltip content={action.label} delayDuration={300}>
      <Link
        to={action.to}
        aria-label={action.label}
        className={ROW_ACTION_CLASS}
      >
        <Icon name={action.icon} className="h-4 w-4" />
      </Link>
    </Tooltip>
  );
}

/**
 * A two-line cell: the thing, then what qualifies it. Used often enough across the
 * list pages that repeating the markup would guarantee drift.
 *
 * forwardRef because callers wrap it in a Tooltip, and Radix attaches the trigger
 * to its child by ref — a plain function component would silently drop it and the
 * tooltip would have nothing to anchor to.
 */
export const CellStack = forwardRef(
  ({ title, subtitle, mono = false, ...props }, ref) => (
    <span ref={ref} className="block min-w-0" {...props}>
      <span className="block truncate">{title}</span>
      {subtitle && (
        <span
          className={cn(
            "mt-1 block truncate text-tiny font-normal leading-5 text-default-500",
            mono && "font-mono",
          )}
        >
          {subtitle}
        </span>
      )}
    </span>
  ),
);
CellStack.displayName = "CellStack";

/** A timestamp that scans as "recently"but can still be read exactly. */
export function TimeCell({ iso, relative: relativeText, absolute }) {
  if (!iso) return <span className="text-default-400">—</span>;
  return (
    <Tooltip content={absolute} delayDuration={300}>
      <span className="whitespace-nowrap text-default-500">{relativeText}</span>
    </Tooltip>
  );
}
