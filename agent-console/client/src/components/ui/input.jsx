import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-small transition-colors",
      "placeholder:text-default-400",
      "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // A file input keeps the system font rather than the browser's.
      "file:mr-3 file:border-0 file:bg-transparent file:text-small file:font-medium file:text-foreground",
      "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/25",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
