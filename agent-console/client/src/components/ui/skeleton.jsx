import { cn } from "@/lib/utils";

/**
 * A sweeping highlight rather than a pulse. Animating background position stops
 * every placeholder on screen from flashing in unison, which reads as a broken
 * screen rather than a loading one.
 */
function Skeleton({ className, ...props }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-lg animate-shimmer bg-[length:200%_100%] bg-gradient-to-r from-content3/70 via-content2 to-content3/70",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
