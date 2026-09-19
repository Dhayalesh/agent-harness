/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * A centred spinner tells the user only that something is happening. A skeleton
 * that matches the eventual layout keeps the page from jumping when data lands and
 * lets the reader start parsing structure before the values arrive.
 *
 * These are the console's shapes; the shimmer itself belongs to the shadcn Skeleton
 * primitive, so there is one animation in the app rather than two that drift.
 * Rounded corners match the cards and controls that replace them.
 */

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function SkeletonText({ className = "w-full" }) {
  return <Skeleton className={cn("block h-3 rounded-full", className)} />;
}

export function SkeletonBlock({ className = "h-24 w-full" }) {
  return <Skeleton className={cn("block", className)} />;
}

/** Placeholder for the metric row at the top of a dashboard or detail page. */
export function SkeletonStats({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 border-y border-divider md:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={cn(
            "px-4 py-3 first:pl-0",
            index > 0 && "border-l border-divider",
          )}
        >
          <SkeletonText className="h-2.5 w-20" />
          <SkeletonBlock className="mt-3 h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a stack of panels or form sections. */
export function SkeletonPanels({ count = 2 }) {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="overflow-hidden rounded-xl border border-divider bg-content1">
          <div className="border-b border-divider bg-content2/50 px-5 py-4">
            <SkeletonText className="h-3.5 w-36" />
          </div>
          <div className="flex flex-col gap-3.5 px-5 py-5">
            <SkeletonText className="w-full" />
            <SkeletonText className="w-4/5" />
            <SkeletonText className="w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
