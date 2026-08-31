import {
  Button,
  Chip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
} from "@heroui/react";
import { SectionCard } from "./Bits.jsx";
import {
  budgetRows,
  humanize,
  issueSummary,
  qualityPresentation,
  qualityScore,
  reportStats,
} from "../lib/context-intelligence.js";

/** Compact live entry point beside the existing context-occupancy meter. */
export function ContextIntelligenceIndicator({ report }) {
  if (!report) return null;
  const quality = qualityPresentation(report);
  const score = qualityScore(report);

  return (
    <Popover placement="top-end" showArrow offset={10}>
      <PopoverTrigger>
        <Button
          size="sm"
          variant="flat"
          color={quality.color}
          className="h-7 min-w-0 px-2 text-tiny font-medium"
          aria-label={`Context Intelligence: ${quality.label}`}
        >
          {score === null ? quality.label : `${quality.label} · ${score}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,390px)] p-0">
        <IntelligenceSummary report={report} compact />
      </PopoverContent>
    </Popover>
  );
}

/** Full run-detail surface using the console's existing card and metric language. */
export function ContextIntelligenceSection({ report }) {
  if (!report) return null;
  const quality = qualityPresentation(report);
  const score = qualityScore(report);

  return (
    <SectionCard
      title="Context Intelligence"
      description="What the runtime selected, checked, and budgeted before the final model turn."
      action={
        <Chip size="sm" variant="flat" color={quality.color}>
          {quality.label}
          {score === null ? "" : ` · ${score}/100`}
        </Chip>
      }
      bodyClassName="px-5 pb-5 pt-2"
    >
      <IntelligenceSummary report={report} />
    </SectionCard>
  );
}

function IntelligenceSummary({ report, compact = false }) {
  const quality = qualityPresentation(report);
  const score = qualityScore(report) ?? 0;
  const allocations = budgetRows(report);
  const issues = issueSummary(report);
  const names = report.capabilities?.names ?? [];

  return (
    <div className={compact ? "w-full p-4" : "flex flex-col gap-5"}>
      {compact && (
        <div className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-small font-semibold">{quality.label}</p>
              <p className="mt-0.5 text-tiny text-default-500">
                {quality.detail}
              </p>
            </div>
            <Chip size="sm" variant="flat" color={quality.color}>
              {score}/100
            </Chip>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {reportStats(report).map((stat) => (
          <div
            key={stat.label}
            className="rounded-medium border border-divider bg-content2 px-3 py-2.5"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-default-500">
              {stat.label}
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {stat.value}
            </p>
            <p className="text-tiny text-default-400">{stat.detail}</p>
          </div>
        ))}
      </div>

      {!compact && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
          <div>
            <Heading>Context budget</Heading>
            <div className="space-y-3 rounded-medium border border-divider bg-content2 p-3.5">
              {allocations.length ? (
                allocations.map((allocation) => (
                  <div key={allocation.category}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-tiny">
                      <span className="font-medium">{allocation.label}</span>
                      <span className="tabular-nums text-default-500">
                        {(allocation.usedTokens ?? 0).toLocaleString()} /{" "}
                        {(allocation.maximumTokens ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <Progress
                      size="sm"
                      aria-label={`${allocation.label} budget`}
                      value={allocation.percent}
                      color={
                        allocation.percent >= 100 ? "warning" : "secondary"
                      }
                      classNames={{ track: "h-1.5" }}
                    />
                  </div>
                ))
              ) : (
                <p className="text-small text-default-500">
                  No category allocation was reported.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <Heading>Decision summary</Heading>
              <dl className="divide-y divide-divider overflow-hidden rounded-medium border border-divider bg-content2">
                <Decision
                  label="Intent"
                  value={`${humanize(report.intent?.operation)} · ${humanize(report.intent?.complexity)}`}
                />
                <Decision
                  label="Task"
                  value={`${humanize(report.task?.status)} · ${report.task?.pending ?? 0} pending`}
                />
                <Decision
                  label="Retrieval"
                  value={
                    report.retrieval?.sufficient ? "Sufficient" : "Insufficient"
                  }
                />
                <Decision
                  label="Reasoning mode"
                  value={humanize(report.reasoning?.mode)}
                />
                <Decision
                  label="Omitted / offloaded"
                  value={`${report.finalContext?.omittedItems ?? 0} / ${report.finalContext?.offloadedArtifacts ?? 0}`}
                />
              </dl>
            </div>

            <div>
              <Heading>Selected capabilities</Heading>
              {names.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {names.map((name) => (
                    <Chip key={name} size="sm" variant="flat">
                      {name}
                    </Chip>
                  ))}
                </div>
              ) : (
                <p className="text-small text-default-500">
                  No tools were needed for the final turn.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {compact && (
        <dl className="mt-3 divide-y divide-divider rounded-medium border border-divider bg-content2 px-3">
          <Decision
            label="Retrieval"
            value={`${report.retrieval?.results ?? 0} results · ${report.retrieval?.iterations ?? 0} iterations`}
          />
          <Decision
            label="Memory recalled"
            value={String(report.memory?.recalled ?? 0)}
          />
          <Decision
            label="Task state"
            value={`${humanize(report.task?.status)} · ${report.task?.pending ?? 0} pending`}
          />
          <Decision
            label="Context changes"
            value={`${report.finalContext?.omittedItems ?? 0} omitted · ${report.finalContext?.offloadedArtifacts ?? 0} offloaded`}
          />
        </dl>
      )}

      {!compact && issues.length > 0 && (
        <div>
          <Heading>Quality findings</Heading>
          <div className="flex flex-wrap gap-2">
            {issues.map((issue) => (
              <Chip
                key={`${issue.code}:${issue.severity}:${issue.remediation}`}
                size="sm"
                variant="flat"
                color={
                  issue.severity === "error"
                    ? "danger"
                    : issue.severity === "warning"
                      ? "warning"
                      : "default"
                }
              >
                {issue.label} · {issue.items} item{issue.items === 1 ? "" : "s"}{" "}
                · {humanize(issue.remediation)}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Heading({ children }) {
  return (
    <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-default-500">
      {children}
    </h3>
  );
}

function Decision({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 text-tiny">
      <dt className="text-default-500">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value || "—"}</dd>
    </div>
  );
}
