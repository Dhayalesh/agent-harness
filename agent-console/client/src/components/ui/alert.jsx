import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A left bar rather than an outline. An alert is an annotation against the
 * content, and a bar in the margin is how a document marks one — an outlined box
 * reads as another panel competing with the page.
 */
const alertVariants = cva(
  "relative flex w-full items-start gap-3 border-l-2 px-4 py-3 text-small [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-l-primary bg-primary/[0.06] text-foreground [&>svg]:text-primary",
        info: "border-l-primary bg-primary/[0.06] text-foreground [&>svg]:text-primary",
        success:
          "border-l-success bg-success/[0.06] text-foreground [&>svg]:text-success",
        warning:
          "border-l-warning bg-warning/[0.06] text-foreground [&>svg]:text-warning",
        destructive:
          "border-l-destructive bg-destructive/[0.06] text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-small font-semibold leading-5", className)}
    {...props}
  />
));
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "wrap-anywhere text-tiny leading-5 text-default-600 [&_p]:leading-5",
      className,
    )}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertDescription, AlertTitle, alertVariants };
