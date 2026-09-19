import { Icon } from "./Icon.jsx";
import { ActivityIndicator } from "./Bits.jsx";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The strip above a collection: find, narrow, switch view.
 *
 * Search used to sit in the page header beside the title, which put a control that
 * acts on the table two headings away from it. Everything that filters the rows
 * belongs against the rows.
 *
 * Controls here are rounded, hairline, and 34px tall — deliberately quieter than the
 * data they operate on.
 */
export function Toolbar({ children, className = "" }) {
  return (
    <div
      className={cn(
        "mb-3 flex flex-col gap-2 rounded-xl border border-divider bg-content2 p-2 sm:flex-row sm:items-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The shared metrics of a toolbar control: 34px tall, on the raised surface. */
const CONTROL = "h-[34px] bg-content1 hover:border-default-300";

export function ToolbarSearch({
  value,
  onValueChange,
  label,
  placeholder = "Search",
  className = "w-full sm:w-[300px]",
}) {
  return (
    // shadcn's Input has no adornment slots, so the icon is positioned over it and
    // the padding is opened up to make room. `pointer-events-none` keeps the glyph
    // from stealing the click that should focus the field.
    <div className={cn("relative", className)}>
      <Icon
        name="search"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-default-400"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className={cn(CONTROL, "pl-8")}
      />
    </div>
  );
}

export function ToolbarSelect({
  value,
  onChange,
  options,
  label,
  icon = "filter",
  className = "w-full sm:w-[178px]",
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={cn(CONTROL, "gap-1.5", className)}
      >
        <Icon
          name={icon}
          className="h-3.5 w-3.5 shrink-0 text-default-400"
        />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.key} value={option.key}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Pushes whatever follows it to the right edge of the toolbar. */
export function ToolbarSpacer() {
  return <span className="hidden flex-1 sm:block" />;
}

/**
 * A segmented control for switching how a collection is drawn. Radio semantics,
 * not buttons: the options are mutually exclusive states, not separate actions.
 * The selected option sits on a raised surface with a subtle outline.
 */
export function ToolbarSegmented({ value, onChange, options, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-[34px] shrink-0 items-stretch gap-1 rounded-lg border border-divider bg-content3/60 p-0.5"
    >
      {options.map((option) => {
        const active = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.key)}
            className={cn(
              "grid w-9 place-items-center rounded-md transition-colors duration-200",
              active
                ? "bg-content1 text-primary shadow-sm ring-1 ring-inset ring-primary/15"
                : "text-default-500 hover:bg-content1/70 hover:text-foreground",
            )}
          >
            <Icon name={option.icon} className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A secondary toolbar action: rounded corners, hairline border, mono label. Used for refresh and
 * similar verbs that operate on the collection rather than creating something.
 */
export function ToolbarButton({ children, icon, busy, className, ...props }) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-busy={busy || undefined}
      className={cn(
        CONTROL,
        "shrink-0 border-divider font-mono text-micro font-medium uppercase tracking-label text-default-600 hover:text-foreground",
        className,
      )}
      {...props}
    >
      {busy ? <ActivityIndicator size="sm" /> : icon && <Icon name={icon} className="h-3.5 w-3.5" />}
      {children}
    </Button>
  );
}
