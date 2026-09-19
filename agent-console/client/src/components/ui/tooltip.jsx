import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

const TooltipProvider = ({ delayDuration = 200, ...props }) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
);

const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef(
  ({ className, sideOffset = 6, children, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          // Inverted: a tooltip is a label on the interface, not another panel in it.
          //
          // The inversion runs on the top of the achromatic ramp, which is near-black
          // on a light canvas. This used to name an undefined `grey` ramp, so the fill
          // and border compiled to nothing and a light-theme tooltip was white text on
          // an unpainted background.
          //
          // `--default-*` inverts with the theme, so dark mode cannot follow it up the
          // ramp and steps onto a raised surface instead.
          "z-[60] max-w-[280px] border border-default-800 bg-default-900 px-2 py-1 text-tiny leading-4 text-background shadow-overlay dark:border-divider dark:bg-content4 dark:text-foreground",
          "data-[state=delayed-open]:animate-content-in",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/**
 * The composed form, which is how this console uses tooltips everywhere:
 * `<Tooltip content="…"><Button/></Tooltip>`.
 *
 * Radix needs Root/Trigger/Content spelled out, and repeating that four-line
 * incantation at ~60 call sites would bury the markup it annotates. `asChild` on
 * the trigger means the wrapped element stays the real DOM node, so a Button
 * inside a Tooltip is still just a button.
 */
const Tooltip = ({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  delayDuration,
  open,
  defaultOpen,
  onOpenChange,
  contentClassName,
  ...props
}) => {
  if (content === null || content === undefined || content === "") {
    return children;
  }
  return (
    <TooltipRoot
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      delayDuration={delayDuration}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={contentClassName}
        {...props}
      >
        {content}
      </TooltipContent>
    </TooltipRoot>
  );
};

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
};
