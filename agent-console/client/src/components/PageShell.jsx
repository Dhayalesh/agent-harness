import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

/** Shared page headings with a clear title, readable context, and actions. */
export function PageShell({
  breadcrumbs,
  title,
  titleAdornment,
  status,
  description,
  actions,
  meta,
  tabs,
  children,
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="mb-6">
        {breadcrumbs?.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-3">
            {/*
              Rendered as a filesystem path. It is denser than chevrons, it reads
 as an address rather than as decoration, and it matches the monospace
 register every other label in the app is set in.
            */}
            <ol className="flex min-w-0 flex-wrap items-center text-tiny">
              {breadcrumbs.map((crumb, index) => (
                <li
                  key={`${crumb.label}-${index}`}
                  className="flex items-center"
                >
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="px-1.5 font-mono text-default-400"
                    >
                      /
                    </span>
                  )}
                  {crumb.to ? (
                    <Link
                      to={crumb.to}
                      className="font-mono font-medium text-default-500 transition-colors hover:text-primary"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="truncate font-medium text-default-500">
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            {titleAdornment}
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <h1 className="min-w-0 truncate text-display font-semibold tracking-display text-foreground">
                  {title}
                </h1>
                {status}
              </div>
              {description && (
                <p className="mt-2 max-w-[80ch] text-small leading-6 text-default-500">
                  {description}
                </p>
              )}
            </div>
          </div>

          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>

        {/* The rule that closes the masthead. Tabs sit on it when present. */}
        {!tabs && <div className="mt-5 h-px w-full bg-foreground/15" />}
        {meta?.length > 0 && <MetaStrip items={meta} />}
        {tabs}
      </header>

      {children}
    </section>
  );
}

/**
 * The record's defining facts as ruled columns.
 *
 * Values are set as light display numerals over tracked-out micro-caps, so a row of
 * measurements reads as an instrument panel. A definition grid of the same facts
 * took four times the height and pushed the actual content below the fold.
 */
export function MetaStrip({ items }) {
  return (
    <dl className="mt-5 grid grid-cols-2 border-y border-divider md:grid-cols-4">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 px-4 py-3 first:pl-0",
            index > 0 && "border-l border-divider",
          )}
        >
          <dt className="label">{item.label}</dt>
          <dd
            className="mt-2 truncate text-medium font-medium text-foreground"
            title={typeof item.value === "string" ? item.value : undefined}
          >
            {item.numeric ? (
              <span className="font-mono tabular-nums">{item.value}</span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Slices of one record in a rounded tab strip. */
export function PageTabs({ tabs, activeKey, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className="mt-5 flex items-center gap-1 overflow-x-auto rounded-xl border border-divider bg-content2 p-1"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2.5 font-mono text-micro uppercase tracking-label transition-colors duration-200",
              active
                ? "bg-content1 font-semibold text-primary shadow-sm"
                : "font-medium text-default-500 hover:bg-primary/[0.05] hover:text-foreground",
            )}
          >
            {tab.icon && <Icon name={tab.icon} className="h-3.5 w-3.5" />}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  "tabular-nums",
                  active ? "text-primary" : "text-default-400",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled value inside a panel, on a hanging monospace label in the left column.
 * Pairs with MetaStrip but stacks, for places where the label needs to be explicit.
 */
export function DefinitionRow({ label, children, hint }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-divider py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-5">
      <dt className="label w-full shrink-0 pt-0.5 sm:w-[180px]">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <span
              tabIndex={0}
              className="ml-1.5 inline-grid h-3 w-3 cursor-help place-items-center align-text-top text-default-400"
            >
              <Icon name="info" className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </dt>
      <dd className="wrap-anywhere min-w-0 flex-1 text-small text-foreground">
        {children}
      </dd>
    </div>
  );
}
