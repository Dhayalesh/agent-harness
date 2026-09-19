import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The six shadcn variants share rounded corners, a 1px rule instead of an
 * elevation, and one hue. `rounded-md` follows the shared radius scale.
 *
 * The size scale is denser than stock. A control plane puts buttons in table rows
 * and toolbars, so `xs` and `icon-sm` exist alongside the standard steps.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-small font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:border-primary/25 hover:bg-primary/[0.05] hover:text-primary",
        secondary: "bg-content3 text-foreground hover:bg-default-200/70",
        ghost: "hover:bg-primary/[0.06] hover:text-primary",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 [&_svg]:size-4",
        xs: "h-6 gap-1.5 px-2 text-tiny [&_svg]:size-3.5",
        sm: "h-8 px-3 text-small [&_svg]:size-4",
        lg: "h-10 px-6 [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-8 [&_svg]:size-4",
        "icon-xs": "size-6 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const Button = React.forwardRef(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    // `asChild` is how a button becomes a react-router <Link> without either
    // component having to know about the other.
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
