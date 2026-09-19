import { createContext, useContext, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { ActivityIndicator } from "./Bits.jsx";
import { Icon } from "./Icon.jsx";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Numbered, two-column form sections.
 *
 * Two things are happening here. The axis is split — what the group is for on the
 * left, the controls on the right — because a single stacked column forces every
 * group to cram its explanation into a subtitle. And each section is numbered,
 * which is the most distinctive mark in the interface: it turns a long form into a
 * document with addressable parts, so "section 03 is wrong"is a sentence someone
 * can actually say.
 *
 * The numbering is automatic. A wrapping FormBody hands out indices in render
 * order, so inserting a section in the middle cannot leave the sequence wrong —
 * which is exactly the bug hand-written numbers always eventually have.
 */
const FormIndexContext = createContext(null);

/** Constrains a form to a comfortable measure and numbers the sections inside it. */
export function FormBody({ children, className = "" }) {
  // A counter object rather than state: it is consumed during render, and the
  // ref survives re-renders without triggering one.
  const counter = useRef(0);
  counter.current = 0;
  const value = useMemo(() => ({ next: () => ++counter.current }), []);

  return (
    <FormIndexContext.Provider value={value}>
      <div className={cn("max-w-[1120px]", className)}>{children}</div>
    </FormIndexContext.Provider>
  );
}

export function FormSection({ title, description, children, aside }) {
  const registry = useContext(FormIndexContext);
  const index = registry ? registry.next() : null;

  return (
    <section className="grid grid-cols-1 gap-x-12 gap-y-5 border-b border-divider py-7 first:pt-0 last:border-b-0 lg:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-4 lg:self-start">
        <div className="flex items-baseline gap-2.5">
          {index !== null && (
            <span aria-hidden="true" className="section-index">
              {String(index).padStart(2, "0")}
            </span>
          )}
          <h2 className="text-large font-semibold text-foreground">{title}</h2>
        </div>
        {description && (
          <p className="mt-2 text-small leading-6 text-default-500">
            {description}
          </p>
        )}
        {aside}
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}

/**
 * Two controls that belong on one line — a name and a slug, a host and a port —
 * without every form re-deriving the same grid.
 */
export function FormRow({ children, className = "" }) {
  return (
    <div className={cn("grid grid-cols-1 gap-5 sm:grid-cols-2", className)}>
      {children}
    </div>
  );
}

/**
 * The save bar.
 *
 * It reports whether there is anything to save, which the previous version did not:
 * a permanently enabled Save button cannot tell you if your edit registered. When
 * the form is clean the bar says so and the button is inert.
 */
export function FormActionBar({
  cancelHref,
  saving,
  dirty = true,
  isDisabled,
  label = "Save",
  destructive,
}) {
  return (
    <div className="sticky bottom-0 z-20 mt-1 flex items-center gap-3 border-t border-foreground/15 bg-background/95 py-3.5 backdrop-blur">
      <Button
        type="submit"
        className="font-semibold"
        disabled={isDisabled || !dirty}
      >
        {saving ? (
          <ActivityIndicator size="sm" className="text-primary-foreground" />
        ) : (
          <Icon name="check" className="h-4 w-4" />
        )}
        {saving ? "Saving…" : label}
      </Button>
      <Button asChild variant="ghost">
        <Link to={cancelHref}>Cancel</Link>
      </Button>

      <span
        className="label ml-auto flex items-center gap-2"
        aria-live="polite"
      >
        {dirty ? (
          <>
            <span aria-hidden="true" className="h-[5px] w-[5px] bg-warning" />
            Unsaved
          </>
        ) : (
          <>
            <span aria-hidden="true" className="h-[5px] w-[5px] bg-success" />
            Saved
          </>
        )}
      </span>

      {destructive}
    </div>
  );
}
