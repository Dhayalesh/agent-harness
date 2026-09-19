import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as React from "react";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef(
  ({ className, children, viewportClassName, viewportRef, ...props }, ref) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      scrollHideDelay={400}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn(
          "size-full [&>div]:!block",
          // Radix puts a display:table wrapper inside the viewport, which
          // collapses percentage heights for anything trying to fill it.
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef(
  ({ className, orientation = "vertical", ...props }, ref) => (
    <ScrollAreaPrimitive.Scrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none bg-transparent p-[3px] transition-opacity",
        orientation === "vertical" && "h-full w-3 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-3 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      {/* Square, matching the native scrollbar this system already restyles. */}
      <ScrollAreaPrimitive.Thumb className="relative flex-1 bg-default-300 transition-colors hover:bg-default-400" />
    </ScrollAreaPrimitive.Scrollbar>
  ),
);
ScrollBar.displayName = ScrollAreaPrimitive.Scrollbar.displayName;

export { ScrollArea, ScrollBar };
