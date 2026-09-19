import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Tinted rather than filled. A row of solid lozenges competes for attention with
 * the data it annotates, so the badge carries a hairline rule and a wash of its
 * own hue at a few percent.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border px-2 py-0.5 font-mono text-micro font-medium uppercase leading-none tracking-label transition-colors [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-primary/25 bg-primary/[0.07] text-primary",
        secondary: "border-divider bg-content3 text-default-600",
        outline: "border-divider text-default-500",
        success: "border-success/25 bg-success/[0.07] text-success",
        warning: "border-warning/25 bg-warning/[0.07] text-warning",
        destructive:
          "border-destructive/25 bg-destructive/[0.07] text-destructive",
        solid: "border-primary bg-primary text-primary-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Badge = React.forwardRef(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "span";
    return (
      <Comp
        ref={ref}
        className={cn(badgeVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };
