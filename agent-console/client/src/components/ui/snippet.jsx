import { Check, Copy } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * A value plus a copy control.
 *
 * The identifiers this shows — run ids, ARNs, S3 URIs, endpoints — are long, and
 * get pasted into other consoles. Making the reader select a truncated string by
 * hand is the failure mode this exists to remove.
 *
 * Composed from Button and Tooltip rather than reaching for the DOM directly, so
 * the copy affordance picks up the same focus ring and hover states as every other
 * control. Confirmation is shown on the icon itself for 1.4s: a toast for something
 * this small would be louder than the action.
 */
const Snippet = React.forwardRef(
  ({ className, children, value, label = "Copy", ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef(null);

    React.useEffect(
      () => () => {
        if (timer.current) clearTimeout(timer.current);
      },
      [],
    );

    const text = value ?? (typeof children === "string" ? children : "");

    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      } catch {
        // A denied clipboard permission leaves the value on screen to select.
      }
    };

    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex max-w-full items-center gap-1 border border-divider bg-content2 py-1 pl-2 pr-1",
          className,
        )}
        {...props}
      >
        <pre className="min-w-0 flex-1 truncate font-mono text-tiny text-default-600">
          {children}
        </pre>
        <Tooltip content={copied ? "Copied" : label}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onCopy}
            aria-label={label}
          >
            {copied ? (
              <Check className="text-success" aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </Tooltip>
      </div>
    );
  },
);
Snippet.displayName = "Snippet";

export { Snippet };
