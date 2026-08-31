/** Small presentational pieces shared by the pages, built on HeroUI. */

import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tooltip,
} from "@heroui/react";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";
import {
  actionDetail,
  actionLabel,
  compactionExplanation,
  contextExplanation,
  contextTimeline,
} from "../lib/context-inspector.js";

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

export function StatusPill({ status, size = "sm", variant = "flat" }) {
  return (
    <Chip
      size={size}
      variant={variant}
      color={STATUS_COLOR[status] ?? "default"}
      classNames={{
        base: "h-5 rounded-full border-none",
        content: "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
      }}
    >
      {status}
    </Chip>
  );
}

export function ErrorNote({ error, className = "" }) {
  if (!error) return null;
  return (
    <Alert
      color="danger"
      variant="flat"
      role="alert"
      title={error.message}
      classNames={{
        base: `mb-4 items-start border border-danger-200 dark:border-danger-500/25 ${className}`,
        title: "text-small font-semibold",
      }}
    >
      {error.details?.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tiny">
          {error.details.map((detail) => (
            <li key={`${detail.field}-${detail.message}`}>
              <code className="font-mono">{detail.field}</code> {detail.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function Loading({ what = "data" }) {
  return (
    <div
      className="flex min-h-[240px] w-full flex-col items-center justify-center gap-3 py-16"
      role="status"
      aria-live="polite"
    >
      <ActivityIndicator />
      <span className="text-small text-default-500">Loading {what}…</span>
    </div>
  );
}

export function ActivityIndicator({ size = "md", className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={`enterprise-loader ${size === "sm" ? "enterprise-loader-sm" : ""} ${className}`}
    />
  );
}

/** A labelled group for controls HeroUI does not label on their own. */
export function Field({ label, hint, error, children, className = "" }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <span className="text-small font-medium text-foreground">{label}</span>
      )}
      {children}
      {hint && <span className="text-tiny text-default-500">{hint}</span>}
      {error && <span className="text-tiny text-danger">{error}</span>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  avatar,
  large = false,
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        {avatar}
        <div className="min-w-0">
          {eyebrow && (
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-secondary">
              {eyebrow}
            </span>
          )}
          <h1
            className={
              large
                ? "text-2xl font-medium tracking-[-0.025em] text-foreground sm:text-3xl lg:text-[2rem]"
                : "text-2xl font-medium tracking-[-0.02em] text-foreground"
            }
          >
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-[64ch] text-small leading-6 text-default-500">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/** The console's one panel shape: bordered card, optional head, flush body. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className = "",
  bodyClassName = "",
}) {
  return (
    <Card
      shadow="none"
      className={`border border-divider bg-content1 shadow-[0_1px_2px_rgba(31,29,26,0.025)] ${className}`}
    >
      {(title || action) && (
        <CardHeader className="flex items-start justify-between gap-4 px-5 pb-0 pt-5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-medium font-semibold text-foreground">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-tiny text-default-500">{description}</p>
            )}
          </div>
          {action}
        </CardHeader>
      )}
      <CardBody className={`px-5 py-4 ${bodyClassName}`}>{children}</CardBody>
    </Card>
  );
}

export function EmptyState({ icon = "spark", title, description, action }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center rounded-large border border-dashed border-divider bg-content1/55 px-5 py-10 text-center">
      <span className="mb-3 grid h-11 w-11 place-items-center rounded-medium border border-divider bg-content2 text-default-600">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <h2 className="text-medium font-semibold text-foreground">{title}</h2>
      {description && (
        <p className="mb-4 mt-1.5 max-w-[46ch] text-small text-default-500">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

export function StatTile({ label, value, detail, className = "" }) {
  return (
    <div
      className={`min-w-0 rounded-large border border-divider bg-content1 px-4 py-3.5 shadow-[0_1px_2px_rgba(31,29,26,0.025)] ${className}`}
    >
      <span className="block text-tiny text-default-500">{label}</span>
      <strong className="my-0.5 block truncate text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </strong>
      {detail && (
        <span className="block text-tiny text-default-400">{detail}</span>
      )}
    </div>
  );
}

/** Definition rows that stay readable at any column count. */
export function MetaGrid({ items, wide = false, className = "" }) {
  return (
    <dl
      className={`grid gap-4 ${
        wide
          ? "grid-cols-[repeat(auto-fit,minmax(190px,1fr))]"
          : "grid-cols-[repeat(auto-fit,minmax(130px,1fr))]"
      } ${className}`}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-default-500">
            {item.label}
          </dt>
          <dd className="wrap-anywhere mt-0.5 text-small text-foreground">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A switch that reads as a setting card rather than a bare control. */
export function ToggleCard({
  label,
  hint,
  isSelected,
  onValueChange,
  className = "",
}) {
  return (
    <Switch
      size="sm"
      isSelected={isSelected}
      onValueChange={onValueChange}
      classNames={{
        base: `inline-flex max-w-full flex-row-reverse items-center justify-between gap-3 rounded-medium border border-divider bg-content2 px-3 py-2.5 data-[selected=true]:border-secondary/50 ${className}`,
        label: "ml-0 min-w-0",
      }}
    >
      <span className="block text-small font-medium">{label}</span>
      {hint && (
        <span className="block max-w-[280px] truncate text-tiny text-default-500">
          {hint}
        </span>
      )}
    </Switch>
  );
}

/** One save/cancel bar shape, pinned so it stays reachable on a long form. */
export function FormActions({ cancelHref, saving, isDisabled, label }) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center gap-2 rounded-large border border-divider bg-content1/90 px-4 py-3 shadow-[0_-8px_24px_rgba(34,31,27,0.04)] backdrop-blur-md">
      <Button
        type="submit"
        color="primary"
        radius="md"
        isDisabled={isDisabled}
        startContent={
          saving ? (
            <ActivityIndicator
              size="sm"
              className="text-white dark:text-black"
            />
          ) : (
            <Icon name="check" className="h-4 w-4" />
          )
        }
      >
        {saving ? "Saving…" : label}
      </Button>
      <Button as={Link} to={cancelHref} variant="light" radius="md">
        Cancel
      </Button>
    </div>
  );
}

export function SearchInput({ value, onValueChange, label, placeholder }) {
  return (
    <Input
      type="search"
      size="sm"
      radius="md"
      variant="bordered"
      value={value}
      onValueChange={onValueChange}
      aria-label={label}
      placeholder={placeholder}
      startContent={<Icon name="search" className="h-4 w-4 text-default-400" />}
      classNames={{
        base: "w-full sm:w-[260px]",
        inputWrapper: "h-9 bg-content1",
      }}
    />
  );
}

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

  const dialog = (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      size="md"
      placement="center"
      backdrop="blur"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2.5 text-medium">
          <span className="grid h-8 w-8 place-items-center rounded-medium bg-danger/10 text-danger">
            <Icon name="alert" className="h-4 w-4" />
          </span>
          {request?.title ?? "Are you sure?"}
        </ModalHeader>
        <ModalBody>
          <p className="text-small text-default-600">{request?.body}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={() => settle(false)}>
            {request?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            color={request?.tone ?? "danger"}
            onPress={() => settle(true)}
            startContent={<Icon name="trash" className="h-4 w-4" />}
          >
            {request?.confirmLabel ?? "Delete"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
      size="md"
      placement="center"
      backdrop="blur"
    >
      <ModalContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) settle(trimmed);
          }}
        >
          <ModalHeader className="flex items-center gap-2.5 text-medium">
            <span className="grid h-8 w-8 place-items-center rounded-medium bg-secondary/10 text-secondary">
              <Icon name={request?.icon ?? "edit"} className="h-4 w-4" />
            </span>
            {request?.title ?? "Rename"}
          </ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              size="sm"
              variant="bordered"
              radius="md"
              label={request?.label}
              placeholder={request?.placeholder}
              value={value}
              maxLength={maxLength}
              onValueChange={setValue}
              // Enter is handled by the form; Escape is handled by the modal.
              classNames={{ inputWrapper: "bg-content1" }}
            />
            {request?.body && (
              <p className="text-tiny text-default-500">{request.body}</p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => settle(null)}>
              {request?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              type="submit"
              color="primary"
              isDisabled={!valid}
              startContent={<Icon name="check" className="h-4 w-4" />}
            >
              {request?.confirmLabel ?? "Save"}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
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

/**
 * The monogram an agent is recognised by across the console. Square in lists and
 * headers; the chat surface asks for the circular variant so it reads as a speaker
 * rather than a record.
 */
export function AgentAvatar({
  name,
  size = "md",
  circle = false,
  className = "",
}) {
  const dimensions = {
    xs: "h-7 w-7 text-[11px]",
    sm: "h-8 w-8 text-tiny",
    md: "h-9 w-9 text-small",
    lg: "h-12 w-12 text-medium",
  }[size];
  const radius = circle
    ? "rounded-full"
    : size === "lg"
      ? "rounded-large"
      : "rounded-medium";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center border border-[#dbc9bc] bg-[#eee2d8] font-semibold text-[#704630] dark:border-[#644638] dark:bg-[#493329] dark:text-[#f0c2aa] ${dimensions} ${radius} ${className}`}
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
 * SVG rather than a HeroUI `CircularProgress` because that component's smallest
 * size still carries a label slot and its own padding, which is more furniture
 * than a composer footer has room for.
 */
function ContextRing({ percent, tone }) {
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * RING_CIRCUMFERENCE;
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
  default: "stroke-secondary",
  warning: "stroke-warning",
  danger: "stroke-danger",
};

const TEXT_TONE = {
  default: "text-default-500",
  warning: "text-warning-600 dark:text-warning-400",
  danger: "text-danger-600 dark:text-danger-400",
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
    (budget ? ` · ${used.toLocaleString()} of ${budget.toLocaleString()} tokens` : "");

  const trigger = (
    <span
      className={`flex items-center gap-1.5 tabular-nums ${TEXT_TONE[band.color]}`}
    >
      <ContextRing percent={percent} tone={RING_TONE[band.color]} />
      <span className="font-medium">{percent}%</span>
    </span>
  );

  if (!onCompact) {
    return (
      <Tooltip content={summary} size="sm" placement="top">
        <span className="flex cursor-default items-center">{trigger}</span>
      </Tooltip>
    );
  }

  return (
    <Popover placement="top-end" showArrow backdrop="opaque">
      <Tooltip content={summary} size="sm" placement="top">
        <span className="flex items-center">
          <PopoverTrigger>
            <Button
              size="sm"
              variant="light"
              className="h-6 min-w-0 gap-1.5 px-1.5 data-[hover=true]:bg-default-100"
              aria-label={`${summary}. Open context options.`}
            >
              {trigger}
            </Button>
          </PopoverTrigger>
        </span>
      </Tooltip>
      <PopoverContent className="w-[268px] p-0">
        <div className="w-full">
          <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
            <Icon name="gauge" className={`h-4 w-4 ${TEXT_TONE[band.color]}`} />
            <span className="text-small font-semibold text-foreground">
              {band.label}
            </span>
            <span
              className={`ml-auto text-small font-semibold tabular-nums ${TEXT_TONE[band.color]}`}
            >
              {percent}%
            </span>
          </div>

          <div className="px-3 py-2.5">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-default-200 dark:bg-default-100"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Context used"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                  { default: "bg-secondary", warning: "bg-warning", danger: "bg-danger" }[
                    band.color
                  ]
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>

            <dl className="mt-2.5 space-y-1 text-tiny">
              <ContextRow label="Used" value={`${used.toLocaleString()} tokens`} />
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
                    context.peakPercent ? ` · ${Math.round(context.peakPercent)}%` : ""
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
              variant="flat"
              color={band.color === "default" ? "secondary" : band.color}
              className="w-full"
              startContent={
                queued ? (
                  <Icon name="check" className="h-3.5 w-3.5" />
                ) : (
                  <Icon name="compact" className="h-3.5 w-3.5" />
                )
              }
              isDisabled={disabled || queued}
              onPress={onCompact}
            >
              {queued ? "Queued for next message" : "Compact context"}
            </Button>
            <p className="mt-2 text-[11px] leading-4 text-default-500">
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
  if (!action && explanation.length === 0 && !compaction && timeline.length === 0) {
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
          <p className="mt-1 text-[11px] leading-4 text-default-500">
            {actionDetail(action)}
          </p>
          {context.verification && (
            <p
              className={`mt-1.5 flex items-center gap-1 text-[11px] ${
                context.verification === "failed"
                  ? "text-warning-600 dark:text-warning-400"
                  : "text-default-500"
              }`}
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
          <ContextSectionTitle>What the model is being told</ContextSectionTitle>
          <dl className="space-y-1 text-tiny">
            {explanation.map((entry) => (
              <ContextRow key={entry.key} label={entry.label} value={entry.value} />
            ))}
          </dl>
        </section>
      )}

      {compaction && (
        <section className="border-t border-divider px-3 py-2.5">
          <ContextSectionTitle>Last compression</ContextSectionTitle>
          {compaction.tokensBefore !== null && compaction.tokensAfter !== null && (
            <p className="text-tiny tabular-nums text-foreground">
              {compaction.tokensBefore.toLocaleString()} →{" "}
              {compaction.tokensAfter.toLocaleString()} tokens
            </p>
          )}
          <p className="mt-1 text-[11px] leading-4 text-default-500">
            {compaction.reason}
          </p>
          {compaction.preserved.length > 0 && (
            <ContextChips label="Kept" items={compaction.preserved} tone="kept" />
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
                className="flex items-baseline gap-2 text-[11px]"
              >
                <span className="w-12 shrink-0 tabular-nums text-default-400">
                  {entry.turn === null ? "—" : `Turn ${entry.turn}`}
                </span>
                <span
                  className={`w-9 shrink-0 tabular-nums font-medium ${
                    TEXT_TONE[contextBand(entry.percent).color]
                  }`}
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
    <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-default-400">
      {children}
    </h4>
  );
}

function ContextChips({ label, items, tone }) {
  return (
    <div className="mt-1.5">
      <span className="text-[10px] uppercase tracking-wide text-default-400">
        {label}
      </span>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className={`rounded-small px-1.5 py-0.5 text-[10px] ${
              tone === "kept"
                ? "bg-success-50 text-success-700 dark:bg-success-100/20 dark:text-success-400"
                : "bg-default-100 text-default-600 dark:text-default-400"
            }`}
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
