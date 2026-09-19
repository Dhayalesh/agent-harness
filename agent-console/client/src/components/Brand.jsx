import { cn } from "@/lib/utils";

/**
 * The product identity, defined once.
 *
 * The mark is a reticle: four ticks addressing a solid centre. It is drawn from the
 * same vocabulary as the rest of the interface — squares and rules, no curves — so
 * the logo looks like it belongs to the product rather than being applied to it.
 * `public/favicon.svg` carries the same geometry so the tab matches the sidebar.
 *
 * Everything visual about the brand is exported from here. It used to be a private
 * helper inside AppShell that ChatPage had copied inline, and the two drifted.
 */

export const APP_NAME = "Enterprise Agents";
export const APP_TAGLINE = "Agent control plane";

/** #0057d2. The signature, stated once so no caller has to remember the hex. */
export const BRAND_HEX = "#0057d2";

/**
 * A solid brand square with a white reticle. Deliberately identical in both themes:
 * a logo that changes colour with the interface stops being a logo, and white on
 * #0057d2 clears contrast requirements against either canvas.
 */
export function BrandMark({ className = "h-7 w-7" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center bg-primary text-primary-foreground",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="h-full w-full" fill="currentColor">
        <rect x="14" y="14" width="4" height="4" />
        <rect x="15" y="5" width="2" height="6" />
        <rect x="15" y="21" width="2" height="6" />
        <rect x="5" y="15" width="6" height="2" />
        <rect x="21" y="15" width="6" height="2" />
      </svg>
    </span>
  );
}

/**
 * Mark plus wordmark. The name is set tight and the tagline becomes a micro-label,
 * which is the same treatment every other structural label in the app receives.
 */
export function BrandLockup({
  subtitle,
  markClassName = "h-7 w-7",
  className = "",
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark className={markClassName} />
      <span className="min-w-0">
        <strong className="block truncate text-small font-semibold leading-tight tracking-[-0.02em] text-foreground">
          {APP_NAME}
        </strong>
        {subtitle && (
          <span className="label mt-1 block truncate text-micro">
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );
}
