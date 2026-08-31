import {
  Alert,
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
  interventionPresentation,
  issueSummary,
  qualityPresentation,
  qualityScore,
  reportStats,
  terminalIntervention,
} from "../lib/context-intelligence.js";

/** Compact live entry point beside the existing context-occupancy meter. */
export function ContextIntelligenceIndicator({ report, intervention }) {
  const terminal =
    terminalIntervention(intervention) ?? terminalIntervention(report);
  if (!report && !terminal) return null;
  const outcome = interventionPresentation(terminal);
  const quality = outcome ?? qualityPresentation(report);
  const score = report ? qualityScore(report) : null;

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
      <PopoverContent className="w-[min(92vw,430px)] p-0">
        <IntelligenceSummary
          report={report}
          intervention={terminal}
          compact
        />
      </PopoverContent>
    </Popover>
  );
}

/** Full run-detail surface using the console's existing card and metric language. */
export function ContextIntelligenceSection({ report, intervention }) {
  const terminal =
    terminalIntervention(intervention) ?? terminalIntervention(report);
  if (!report && !terminal) return null;
  const outcome = interventionPresentation(terminal);
  const quality = outcome ?? qualityPresentation(report);
  const score = report ? qualityScore(report) : null;

  return (
    <SectionCard
      title="Context Intelligence"
      description="What the runtime selected, checked, and budgeted before the final model decision or terminal intervention."
      action={
        <Chip size="sm" variant="flat" color={quality.color}>
          {quality.label}
          {score === null ? "" : ` · ${score}/100`}
        </Chip>
      }
      bodyClassName="px-5 pb-5 pt-2"
    >
      <IntelligenceSummary report={report} intervention={terminal} />
    </SectionCard>
  );
}

/** Application-level outcome; never presented as model-authored assistant prose. */
export function ContextInterventionAlert({
  intervention,
  compact = false,
  className = "",
}) {
  const outcome = interventionPresentation(intervention);
  if (!outcome) return null;
  const { reasonCodes, clarificationNeeds } = outcome.intervention;

  return (
    <Alert
      color={outcome.color}
      variant="flat"
      title={outcome.label}
      className={className}
      classNames={{
        base: "items-start border border-current/20",
        title: "text-small font-semibold",
      }}
    >
      <p className="text-tiny">{outcome.detail}</p>
      {!compact && (reasonCodes.length > 0 || clarificationNeeds.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reasonCodes.map((reason) => (
            <Chip key={`reason:${reason}`} size="sm" variant="flat">
              {humanize(reason)}
            </Chip>
          ))}
          {clarificationNeeds.map((need) => (
            <Chip key={`need:${need}`} size="sm" variant="bordered">
              Needs {humanize(need)}
            </Chip>
          ))}
        </div>
      )}
    </Alert>
  );
}

function IntelligenceSummary({ report, intervention, compact = false }) {
  const terminal =
    terminalIntervention(intervention) ?? terminalIntervention(report);
  if (!report) {
    return (
      <div className={compact ? "w-full p-4" : "flex flex-col gap-4"}>
        <ContextInterventionAlert intervention={terminal} compact={compact} />
      </div>
    );
  }

  const quality = qualityPresentation(report);
  const score = qualityScore(report) ?? 0;
  const allocations = budgetRows(report);
  const issues = issueSummary(report);
  const names = report.capabilities?.names ?? [];
  const reconciliation = report.memory?.reconciliation;
  const evaluation = report.evaluation;

  return (
    <div className={compact ? "w-full p-4" : "flex flex-col gap-5"}>
      {terminal && (
        <ContextInterventionAlert intervention={terminal} compact={compact} />
      )}

      {compact && (
        <div>
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
                  label="Quality decision"
                  value={humanize(report.quality?.decision)}
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
                  No tools were needed for the final decision.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {compact && (
        <dl className="divide-y divide-divider rounded-medium border border-divider bg-content2 px-3">
          <Decision
            label="Retrieval"
            value={`${report.retrieval?.results ?? 0} results · ${report.retrieval?.iterations ?? 0} iterations`}
          />
          <Decision
            label="Operations"
            value={countMap(report.retrieval?.operationOutcomes)}
          />
          <Decision
            label="Memory"
            value={`${report.memory?.recalled ?? 0} recalled · ${reconciliation?.retained ?? 0} retained`}
          />
          <Decision
            label="Lifecycle"
            value={`${report.lifecycle?.events ?? 0} events · ${report.finalContext?.activeItems ?? 0} active`}
          />
          <Decision
            label="Context changes"
            value={`${report.finalContext?.omittedItems ?? 0} omitted · ${report.finalContext?.offloadedArtifacts ?? 0} offloaded`}
          />
        </dl>
      )}

      {!compact && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <Heading>Lifecycle and reconciliation</Heading>
            <dl className="divide-y divide-divider overflow-hidden rounded-medium border border-divider bg-content2">
              <Decision
                label="Retrieval operations"
                value={`${report.retrieval?.operations ?? 0} · ${countMap(report.retrieval?.operationOutcomes)}`}
              />
              <Decision
                label="Memory reconciliation"
                value={`${reconciliation?.retained ?? 0} retained · ${reconciliation?.ignored ?? 0} ignored · ${reconciliation?.stale ?? 0} stale · ${reconciliation?.conflicts ?? 0} conflicts`}
              />
              <Decision
                label="Lifecycle transitions"
                value={`${report.lifecycle?.events ?? 0} · ${countMap(report.lifecycle?.states)}`}
              />
              <Decision
                label="Canonical / active"
                value={`${report.finalContext?.canonicalItems ?? report.finalContext?.items ?? 0} / ${report.finalContext?.activeItems ?? 0}`}
              />
              <Decision
                label="Provenance"
                value={`${report.finalContext?.provenanceRecords ?? 0} records · ${report.finalContext?.sources ?? 0} sources`}
              />
            </dl>
          </div>

          <div>
            <Heading>P3 adaptive signals</Heading>
            <dl className="divide-y divide-divider overflow-hidden rounded-medium border border-divider bg-content2">
              <Decision
                label="Feedback"
                value={
                  report.feedback
                    ? `${report.feedback.total ?? 0} · categories ${countMap(report.feedback.categories)} · outcomes ${countMap(report.feedback.outcomes)}`
                    : "Not enabled or not reported"
                }
              />
              <Decision
                label="Prediction"
                value={
                  report.prediction
                    ? `${report.prediction.hints ?? 0} hints · ${report.prediction.satisfiedDependencies ?? 0} dependencies · ${report.prediction.evidenceReferences ?? 0} evidence${report.prediction.truncated ? " · truncated" : ""}`
                    : "Not enabled or not reported"
                }
              />
              <Decision
                label="Optimization"
                value={optimizationSummary(report.optimization)}
              />
              <Decision
                label="Operation success"
                value={ratioSummary(evaluation?.operationSuccess)}
              />
              <Decision
                label="Retrieval usefulness"
                value={ratioSummary(
                  evaluation?.classifiedRetrievalUsefulness,
                )}
              />
              <Decision
                label="Evidence utilization"
                value={ratioSummary(evaluation?.evidenceUtilization)}
              />
              <Decision
                label="Memory retention / gate rejection"
                value={`${ratioSummary(evaluation?.memoryRetention)} / ${ratioSummary(evaluation?.gateRejection)}`}
              />
              <Decision
                label="Observed latency / cost"
                value={evaluationSummary(evaluation)}
              />
              <Decision
                label="Unavailable metrics"
                value={unavailableMetrics(evaluation)}
              />
            </dl>
          </div>
        </div>
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

function countMap(value) {
  if (!value || typeof value !== "object") return "none";
  const entries = Object.entries(value)
    .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return "none";
  return entries
    .map(([key, count]) => `${humanize(key)} ${Number(count).toLocaleString()}`)
    .join(" · ");
}

function ratioSummary(value) {
  if (!value || !Number.isFinite(Number(value.value))) return "Not reported";
  return `${Math.round(Number(value.value) * 100)}% (${value.numerator ?? 0}/${value.denominator ?? 0})`;
}

function optimizationSummary(value) {
  if (!value) return "Not enabled or not reported";
  if (!value.enabled) {
    return value.unavailableReason
      ? humanize(value.unavailableReason)
      : "Disabled";
  }
  return `${value.reorderedSelections ?? 0} reordered · ${value.eligibleProfiles ?? 0} eligible profiles · ${value.durationSamples ?? 0} duration samples · ${value.costSamples ?? 0} cost samples`;
}

function evaluationSummary(value) {
  if (!value) return "Not enabled or not reported";
  const samples = value.latency?.samples ?? 0;
  const mean = Number(value.latency?.meanMs);
  const latency = Number.isFinite(mean)
    ? `${Math.round(mean).toLocaleString()} ms mean (${samples})`
    : `${samples} latency samples`;
  const costs = Array.isArray(value.costs)
    ? value.costs.reduce((total, entry) => total + (Number(entry.samples) || 0), 0)
    : 0;
  return `${latency} · ${costs} observed cost samples`;
}

function unavailableMetrics(value) {
  if (!value) return "Not enabled or not reported";
  const entries = Array.isArray(value.unavailable) ? value.unavailable : [];
  if (!entries.length) return "none";
  return entries
    .map((entry) => `${humanize(entry.metric)}: ${humanize(entry.reason)}`)
    .join(" · ");
}