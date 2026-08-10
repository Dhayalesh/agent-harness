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
  Spinner,
  Switch,
} from "@heroui/react";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.jsx";

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
    <div className="flex min-h-[240px] w-full items-center justify-center py-16">
      <Spinner color="primary" label={`Loading ${what}…`} labelColor="foreground" />
    </div>
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
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.11em] text-primary">
              {eyebrow}
            </span>
          )}
          <h1
            className={
              large
                ? "text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-[2.1rem]"
                : "text-2xl font-semibold tracking-tight text-foreground"
            }
          >
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-[62ch] text-small text-default-500">
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
      className={`border border-divider bg-content1 ${className}`}
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
    <div className="flex min-h-[280px] flex-col items-center justify-center rounded-large border border-dashed border-divider bg-content1/40 px-5 py-10 text-center">
      <span className="mb-3 grid h-11 w-11 place-items-center rounded-medium bg-primary/10 text-primary">
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
      className={`min-w-0 rounded-large border border-divider bg-content1 px-4 py-3.5 ${className}`}
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
        base: `inline-flex max-w-full flex-row-reverse items-center justify-between gap-3 rounded-medium border border-divider bg-content2 px-3 py-2.5 data-[selected=true]:border-primary/40 ${className}`,
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
    <div className="sticky bottom-0 z-10 flex items-center gap-2 rounded-large border border-divider bg-content1/85 px-4 py-3 backdrop-blur-md">
      <Button
        type="submit"
        color="primary"
        radius="md"
        isLoading={saving}
        isDisabled={isDisabled}
        startContent={saving ? null : <Icon name="check" className="h-4 w-4" />}
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
      classNames={{ base: "w-full sm:w-[260px]", inputWrapper: "h-9 bg-content1" }}
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
export function AgentAvatar({ name, size = "md", circle = false, className = "" }) {
  const dimensions = {
    xs: "h-7 w-7 text-[11px]",
    sm: "h-8 w-8 text-tiny",
    md: "h-9 w-9 text-small",
    lg: "h-12 w-12 text-medium",
  }[size];
  const radius = circle ? "rounded-full" : size === "lg" ? "rounded-large" : "rounded-medium";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center bg-gradient-to-br from-primary to-secondary font-bold text-white ${dimensions} ${radius} ${className}`}
    >
      {(name ?? "?").trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
