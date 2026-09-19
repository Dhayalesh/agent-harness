/** Small presentational pieces shared by the pages, built on shadcn/ui. */

import { useCallback, useId, useRef, useState } from "react";
import { Icon } from "./Icon.jsx";
import {
  actionDetail,
  actionLabel,
  compactionExplanation,
  contextExplanation,
  contextTimeline,
} from "../lib/context-inspector.js";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Status words arrive from several collections — run status, resource state, a
 * transport name — so the map is keyed by the word rather than by its source.
 */
const STATUS_COLOR = {
  success: "success",
  enabled: "success",
  completed: "success",
  ready: "success",
  done: "success",
  error: "danger",
  failed: "danger",
  bypass: "danger",
  missing: "danger",
  running: "warning",
  pending: "warning",
  intervened: "warning",
  plan: "warning",
  default: "primary",
  auto: "primary",
  streaming: "secondary",
  disabled: "default",
};

/** The dot restates the status without relying on hue alone to carry it. */
const STATUS_DOT = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  primary: "bg-primary",
  secondary: "bg-secondary",
  default: "bg-default-400",
};

/** Text tone per state, so the word carries the meaning as well as the dot. */
const STATUS_TEXT = {
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
  primary: "text-primary",
  secondary: "text-secondary",
  default: "text-default-500",
};

/** A compact status label with a round dot and readable sentence-case text. */
export function StatusPill({ status }) {
  const color = STATUS_COLOR[status] ?? "default";
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 align-middle">
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[color])}
      />
      <span
        className={cn(
          "text-tiny font-medium capitalize leading-5",
          STATUS_TEXT[color],
        )}
      >
        {status}
      </span>
    </span>
  );
}

/**
 * A type label: what kind of thing this is.
 *
 * A bracketed monospace token rather than a badge. Classification is reference
 * information — you read it when you need it — so it is set quietly, and the
 * brackets give it an edge without adding a filled shape to the row.
 */
const TAG_TONE = {
  neutral: "text-default-500",
  brand: "text-primary",
};

export function Tag({ children, tone = "neutral", className = "" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center font-mono text-micro font-medium uppercase leading-none tracking-label",
        TAG_TONE[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="opacity-40">
        [
      </span>
      {children}
      <span aria-hidden="true" className="opacity-40">
        ]
      </span>
    </span>
  );
}

/** Monospace inline value for endpoints, URIs and commands. */
export function MonoValue({ children, className = "" }) {
  return (
    <span
      className={cn(
        "wrap-anywhere font-mono text-tiny text-default-600",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ErrorNote({ error, className = "" }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" className={cn("mb-4", className)}>
      <div className="min-w-0 flex-1">
        <AlertTitle>{error.message}</AlertTitle>
        {error.details?.length > 0 && (
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {error.details.map((detail) => (
                <li key={`${detail.field}-${detail.message}`}>
                  <code className="font-mono">{detail.field}</code>{" "}
                  {detail.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        )}
      </div>
    </Alert>
  );
}

export function Loading({ what = "data" }) {
  return (
    <div
      className="flex min-h-[240px] w-full flex-col items-center justify-center gap-5 px-4 py-16"
      role="status"
      aria-live="polite"
    >
      <span className="grid size-16 place-items-center rounded-2xl border border-primary/10 bg-primary/[0.05] text-primary shadow-sm">
        <ActivityIndicator className="size-7" />
      </span>
      <span className="text-small font-medium text-default-600">Loading {what}…</span>
    </div>
  );
}

export function ActivityIndicator({ size = "md", className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "enterprise-loader",
        size === "sm" && "enterprise-loader-sm",
        className,
      )}
    />
  );
}

/**
 * A labelled group for a control that does not label itself.
 *
 * The label is a real <label>: `htmlFor` is threaded through when the caller names
 * the control, so clicking the text focuses the input and a screen reader reads the
 * two as one thing.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className = "",
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label && (
        <Label htmlFor={htmlFor} className="label">
          {label}
        </Label>
      )}
      {children}
      {hint && (
        <span className="text-tiny leading-5 text-default-500">{hint}</span>
      )}
      {error && <span className="text-tiny text-danger">{error}</span>}
    </div>
  );
}

/**
 * The console's one panel shape: bordered card, titled head, flush body.
 *
 * Page-level headers are not here — see PageShell, which supersedes the old
 * PageHeader with breadcrumbs, status, a meta strip and tabs.
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  className = "",
  bodyClassName = "",
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      {(title || action) && (
        <CardHeader>
          <div className="min-w-0">
            {title && <CardTitle>{title}</CardTitle>}
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {action}
        </CardHeader>
      )}
      <CardContent className={bodyClassName}>{children}</CardContent>
    </Card>
  );
}

/**
 * Nothing here yet.
 *
 * The icon sits in a square brand block and the copy is centred on a short
 * measure. No dashed border: a dashed rectangle is the universal placeholder
 * cliché, and a plain ruled frame says the same thing without the costume.
 */
export function EmptyState({ icon = "spark", title, description, action }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center px-5 py-14 text-center">
      <span className="mb-5 grid h-9 w-9 place-items-center bg-primary text-primary-foreground">
        <Icon name={icon} className="h-[18px] w-[18px]" strokeWidth={1.6} />
      </span>
      <h2 className="text-medium font-semibold text-foreground">{title}</h2>
      {description && (
        <p className="mb-5 mt-2 max-w-[44ch] text-small leading-6 text-default-500">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

/**
 * A switch that reads as a setting card rather than a bare control.
 *
 * Selected settings use a soft tint and a rounded border.
 *
 * The tile is a plain element and the Switch is the only interactive thing in it,
 * pointed at the copy through `aria-labelledby`/`aria-describedby`. Wrapping the
 * whole tile in a <label> would be a larger hit target, but Radix's Switch renders a
 * <button>, and label-click forwarding to a button is not something browsers agree
 * on — so the tint is driven from the prop rather than from a `:checked` selector
 * that only exists when the switch happens to sit inside a form.
 *
 * Metric tiles and definition grids used to live here too. They were replaced by
 * PageShell's MetaStrip and the per-page Metric component, which compress the same
 * facts into a header instead of spending a screenful of vertical space on them.
 */
export function ToggleCard({
  label,
  hint,
  isSelected,
  onValueChange,
  className = "",
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center justify-between gap-4 rounded-xl border px-3.5 py-3 transition-colors duration-200 focus-within:border-primary/50",
        isSelected
          ? "border-primary/25 bg-primary/[0.05] hover:bg-primary/[0.08]"
          : "border-divider bg-content1 hover:border-primary/20 hover:bg-primary/[0.03]",
        className,
      )}
    >
      <span className="min-w-0">
        <span id={`${id}-label`} className="block text-small font-medium">
          {label}
        </span>
        {hint && (
          <span
            id={`${id}-hint`}
            className="block max-w-[280px] truncate text-tiny text-default-500"
          >
            {hint}
          </span>
        )}
      </span>
      <Switch
        checked={Boolean(isSelected)}
        onCheckedChange={onValueChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
    </div>
  );
}

/*
 * The save bar lives in FormLayout.jsx as FormActionBar, which additionally
 * reports dirty state; the list search box lives in Toolbar.jsx as ToolbarSearch,
 * beside the rows it filters rather than up in the page header.
 */

/**
 * `window.confirm` blocks the whole tab and cannot be themed, which is the wrong
 * shape for a destructive action in a console. This keeps the call site's
 * `await confirm(...)` ergonomics and renders a real dialog instead.
 */
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef(null);

  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setRequest(options);
        setOpen(true);
      }),
    [],
  );

  // The request outlives the close so the dialog does not blank out mid-animation.
  const settle = useCallback((answer) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(answer);
  }, []);

  const destructive = (request?.tone ?? "danger") === "danger";

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
    >
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center",
              // Each fill carries its own foreground token rather than a literal
              // white: in dark mode `--destructive` lifts to a light red that needs
              // dark type on it, so a hardcoded white icon would wash out.
              destructive
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground",
            )}
          >
            <Icon name="alert" className="h-4 w-4" />
          </span>
          <DialogTitle>{request?.title ?? "Are you sure?"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-small text-default-600">{request?.body}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>
            {request?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            <Icon name="trash" className="h-4 w-4" />
            {request?.confirmLabel ?? "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return [confirm, dialog];
}

/**
 * `useConfirm` for a value rather than a yes/no.
 *
 * Resolves to the trimmed string, or null when the dialog was dismissed, so a call
 * site can `await` a rename the same way it awaits a confirmation. Submitting an
 * unchanged value still resolves, and the caller decides whether that is a no-op.
 */
export function usePrompt() {
  const [request, setRequest] = useState(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const resolver = useRef(null);

  const prompt = useCallback(
    (options = {}) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setRequest(options);
        setValue(options.defaultValue ?? "");
        setOpen(true);
      }),
    [],
  );

  const settle = useCallback((answer) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(answer);
  }, []);

  const maxLength = request?.maxLength ?? 200;
  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= maxLength;

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
    >
      <DialogContent className="max-w-[440px]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) settle(trimmed);
          }}
        >
          <DialogHeader>
            <span className="grid h-8 w-8 shrink-0 place-items-center bg-primary text-primary-foreground">
              <Icon name={request?.icon ?? "edit"} className="h-4 w-4" />
            </span>
            <DialogTitle>{request?.title ?? "Rename"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <Field label={request?.label} htmlFor="prompt-value">
              <Input
                id="prompt-value"
                autoFocus
                value={value}
                maxLength={maxLength}
                placeholder={request?.placeholder}
                onChange={(event) => setValue(event.target.value)}
                // Enter is handled by the form; Escape is handled by the dialog.
              />
            </Field>
            {request?.body && (
              <p className="text-tiny text-default-500">{request.body}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => settle(null)}>
              {request?.cancelLabel ?? "Cancel"}
            </Button>
            <Button type="submit" disabled={!valid}>
              <Icon name="check" className="h-4 w-4" />
              {request?.confirmLabel ?? "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return [prompt, dialog];
}

/** Milliseconds as something a person reads at a glance. */
export function duration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/** Clock time only, for timestamps that sit next to a message. */
export function clock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Compact age for dense lists where a full locale string is too long. */
export function relative(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function tokens(usage) {
  if (!usage) return "—";
  const total =
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (!total) return "—";
  return `${total.toLocaleString()} tok`;
}

/** A softly tinted agent monogram, with an optional circular chat variant. */
export function AgentAvatar({
  name,
  size = "md",
  circle = false,
  className = "",
}) {
  const dimensions = {
    xs: "h-7 w-7 text-tiny",
    sm: "h-8 w-8 text-tiny",
    md: "h-9 w-9 text-small",
    lg: "h-12 w-12 text-medium",
  }[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-lg bg-primary/[0.1] font-semibold text-primary ring-1 ring-inset ring-primary/10",
        dimensions,
        circle && "rounded-full",
        className,
      )}
    >
      {(name ?? "?").trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

/**
 * The context budget, as a fraction rather than a count.
 *
 * A token total answers "how much was spent", which is a billing question. What a
 * reader of a live conversation actually needs is "how much room is left", and that
 * is a percentage of a budget only the runtime knows — the model's window less the
 * reply it has to leave space for. So the number shown is the one the harness
 * measured, and this only decides how to present it.
 *
 * Three bands, matching the policy thresholds the context layer applies:
 * comfortable below 70%, warning to 90%, and danger above — the last being where
 * compaction happens on its own. Colour is not the only carrier: the tooltip and
 * the popover both state the percentage in words for anyone who cannot use it.
 */
const CONTEXT_BANDS = [
  { limit: 70, color: "default", label: "Context" },
  { limit: 90, color: "warning", label: "Context filling up" },
  { limit: Infinity, color: "danger", label: "Context nearly full" },
];

export function contextBand(percent) {
  return CONTEXT_BANDS.find((band) => (percent ?? 0) < band.limit);
}

/** Whole numbers only: a context meter reading 43.7% invites false precision. */
export function contextPercent(context) {
  if (!context || typeof context.usedPercent !== "number") return null;
  return Math.min(100, Math.max(0, Math.round(context.usedPercent)));
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 7;

/**
 * A 20px ring that fills clockwise, sized to sit inline beside a status pill.
 *
 * Hand-drawn SVG because this is a gauge, not a bar: shadcn's Progress is a linear
 * track, and the linear form is already used inside the panel below. A ring reads as
 * "how full", which is the question a budget indicator answers.
 */
function ContextRing({ percent, tone }) {
  const filled =
    (Math.min(100, Math.max(0, percent)) / 100) * RING_CIRCUMFERENCE;
  return (
    <svg
      className="h-4 w-4 shrink-0 -rotate-90"
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        strokeWidth="2.5"
        className="stroke-default-200 dark:stroke-default-100"
      />
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        className={tone}
        style={{ transition: "stroke-dasharray 300ms ease-out" }}
      />
    </svg>
  );
}

const RING_TONE = {
  default: "stroke-primary",
  warning: "stroke-warning",
  danger: "stroke-danger",
};

const TEXT_TONE = {
  default: "text-default-500",
  warning: "text-warning-600 dark:text-warning-400",
  danger: "text-danger-600 dark:text-danger-400",
};

const BAR_TONE = {
  default: "bg-primary",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * The context inspector: what the harness decided, and why.
 *
 * Hover states the percentage; pressing opens the panel. The panel is a report, not a
 * control surface — the only thing a user can do here is ask for a compaction sooner
 * than the threshold would have triggered one. Everything else is the harness
 * explaining itself: how full the context is, the most recent automatic action, what
 * is being kept, and what was compressed to make room.
 *
 * There is deliberately no token tuning in here. The runtime derives its retention
 * sizes, summary shares and tool-result allowances from the model and the
 * conversation, and a slider that appeared to override one of them would be a lie
 * about where the decision is made.
 *
 * `onCompact` is optional — without one this is a read-only indicator, which is what
 * a finished run or a chat with no agent should show.
 *
 * `queued` covers the gap between asking for compaction and it happening: it runs in
 * front of the next model request, so the button reports that it is armed rather
 * than pretending the work is already done.
 */
export function ContextMeter({
  context,
  onCompact,
  queued = false,
  disabled = false,
}) {
  const percent = contextPercent(context);
  if (percent === null) return null;

  const band = contextBand(percent);
  const used = context.usedTokens ?? 0;
  const budget = context.budgetTokens ?? 0;
  const summary =
    `${band.label} · ${percent}% used` +
    (budget
      ? ` · ${used.toLocaleString()} of ${budget.toLocaleString()} tokens`
      : "");

  const trigger = (
    <span
      className={cn(
        "flex items-center gap-1.5 tabular-nums",
        TEXT_TONE[band.color],
      )}
    >
      <ContextRing percent={percent} tone={RING_TONE[band.color]} />
      <span className="font-medium">{percent}%</span>
    </span>
  );

  if (!onCompact) {
    return (
      <Tooltip content={summary}>
        <span className="flex cursor-default items-center">{trigger}</span>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <Tooltip content={summary}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 px-1.5"
            aria-label={`${summary}. Open context options.`}
          >
            {trigger}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[268px] p-0">
        <div className="w-full">
          <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
            <Icon name="gauge" className={cn("h-4 w-4", TEXT_TONE[band.color])} />
            <span className="text-small font-semibold text-foreground">
              {band.label}
            </span>
            <span
              className={cn(
                "ml-auto text-small font-semibold tabular-nums",
                TEXT_TONE[band.color],
              )}
            >
              {percent}%
            </span>
          </div>

          <div className="px-3 py-2.5">
            <Progress
              value={percent}
              aria-label="Context used"
              indicatorClassName={BAR_TONE[band.color]}
            />

            <dl className="mt-2.5 space-y-1 text-tiny">
              <ContextRow
                label="Used"
                value={`${used.toLocaleString()} tokens`}
              />
              {budget > 0 && (
                <ContextRow
                  label="Budget"
                  value={`${budget.toLocaleString()} tokens`}
                />
              )}
              {context.contextWindow > 0 && (
                <ContextRow
                  label="Model window"
                  value={`${context.contextWindow.toLocaleString()} tokens`}
                />
              )}
              {context.reservedOutputTokens > 0 && (
                <ContextRow
                  label="Reserved for reply"
                  value={`${context.reservedOutputTokens.toLocaleString()} tokens`}
                />
              )}
              {/* Only worth a row once it differs from the current reading: on a
                  turn that did not compact the two are the same number. */}
              {context.peakTokens > used && (
                <ContextRow
                  label="Peak before compaction"
                  value={`${context.peakTokens.toLocaleString()} tokens${
                    context.peakPercent
                      ? ` · ${Math.round(context.peakPercent)}%`
                      : ""
                  }`}
                />
              )}
              {context.compactions > 0 && (
                <ContextRow
                  label="Compactions"
                  value={`${context.compactions} this run`}
                />
              )}
            </dl>
          </div>

          <ContextInspectorSections context={context} />

          <div className="border-t border-divider px-3 py-2.5">
            <Button
              size="sm"
              variant={band.color === "danger" ? "destructive" : "secondary"}
              className="w-full"
              disabled={disabled || queued}
              onClick={onCompact}
            >
              <Icon
                name={queued ? "check" : "compact"}
                className="h-3.5 w-3.5"
              />
              {queued ? "Queued for next message" : "Compact context"}
            </Button>
            <p className="mt-2 text-tiny leading-4 text-default-500">
              {queued
                ? "Earlier turns will be summarised before the next reply."
                : "Context is managed automatically. This only asks for it sooner. Your messages stay in this chat."}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The explanatory half of the panel.
 *
 * Every section renders only when the runtime reported the data behind it, so a
 * console talking to a runtime without the orchestration layer shows the same meter
 * it always did rather than a column of empty headings.
 */
function ContextInspectorSections({ context }) {
  const action = context?.action;
  const explanation = contextExplanation(context);
  const compaction = compactionExplanation({
    context,
    lastCompaction: context?.lastCompaction,
  });
  const timeline = contextTimeline(context?.timeline ?? []);
  if (
    !action &&
    explanation.length === 0 &&
    !compaction &&
    timeline.length === 0
  ) {
    return null;
  }

  return (
    <>
      {action && (
        <section className="border-t border-divider px-3 py-2.5">
          <ContextSectionTitle>Latest automatic action</ContextSectionTitle>
          <p className="text-tiny font-medium text-foreground">
            {actionLabel(action)}
          </p>
          <p className="mt-1 text-tiny leading-4 text-default-500">
            {actionDetail(action)}
          </p>
          {context.verification && (
            <p
              className={cn(
                "mt-1.5 flex items-center gap-1 text-tiny",
                context.verification === "failed"
                  ? "text-warning-600 dark:text-warning-400"
                  : "text-default-500",
              )}
            >
              <Icon
                name={context.verification === "failed" ? "alert" : "check"}
                className="h-3 w-3"
              />
              {VERIFICATION_TEXT[context.verification] ?? context.verification}
            </p>
          )}
        </section>
      )}

      {explanation.length > 0 && (
        <section className="border-t border-divider px-3 py-2.5">
          <ContextSectionTitle>
            What the model is being told
          </ContextSectionTitle>
          <dl className="space-y-1 text-tiny">
            {explanation.map((entry) => (
              <ContextRow
                key={entry.key}
                label={entry.label}
                value={entry.value}
              />
            ))}
          </dl>
        </section>
      )}

      {compaction && (
        <section className="border-t border-divider px-3 py-2.5">
          <ContextSectionTitle>Last compression</ContextSectionTitle>
          {compaction.tokensBefore !== null &&
            compaction.tokensAfter !== null && (
              <p className="text-tiny tabular-nums text-foreground">
                {compaction.tokensBefore.toLocaleString()} →{" "}
                {compaction.tokensAfter.toLocaleString()} tokens
              </p>
            )}
          <p className="mt-1 text-tiny leading-4 text-default-500">
            {compaction.reason}
          </p>
          {compaction.preserved.length > 0 && (
            <ContextChips
              label="Kept"
              items={compaction.preserved}
              tone="kept"
            />
          )}
          {compaction.compressed.length > 0 && (
            <ContextChips
              label="Compressed"
              items={compaction.compressed}
              tone="compressed"
            />
          )}
        </section>
      )}

      {timeline.length > 0 && (
        <section className="border-t border-divider px-3 py-2.5">
          <ContextSectionTitle>This conversation</ContextSectionTitle>
          <ol className="space-y-1">
            {timeline.map((entry, index) => (
              <li
                key={`${entry.turn ?? "t"}-${index}`}
                className="flex items-baseline gap-2 text-tiny"
              >
                <span className="w-12 shrink-0 tabular-nums text-default-400">
                  {entry.turn === null ? "—" : `Turn ${entry.turn}`}
                </span>
                <span
                  className={cn(
                    "w-9 shrink-0 tabular-nums font-medium",
                    TEXT_TONE[contextBand(entry.percent).color],
                  )}
                >
                  {entry.percent}%
                </span>
                <span className="text-default-500">{entry.label}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

const VERIFICATION_TEXT = {
  passed: "Checked: nothing important was lost.",
  recovered: "A check found missing detail and restored it.",
  failed: "A check could not confirm every detail survived.",
};

function ContextSectionTitle({ children }) {
  return (
    <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-default-400">
      {children}
    </h4>
  );
}

function ContextChips({ label, items, tone }) {
  return (
    <div className="mt-1.5">
      <span className="text-micro uppercase tracking-wide text-default-400">
        {label}
      </span>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className={cn(
              "border-l-2 bg-content2 px-1.5 py-0.5 font-mono text-micro",
              tone === "kept"
                ? "border-l-success text-default-600"
                : "border-l-default-300 text-default-500",
            )}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function ContextRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-default-500">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
