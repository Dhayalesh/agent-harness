import { Button, ScrollShadow } from "@heroui/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  PageHeader,
  SectionCard,
  StatTile,
  StatusPill,
  duration,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";

/**
 * The waterfall view of one trace: every span (a model call or a tool call)
 * positioned and sized by its own start time and duration, relative to the
 * whole trace. See docs/observability-platform-plan.md §2 for what "trace"
 * and "span" mean here, and §9 for the design this was built against.
 */
export function TraceDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    setData(null);
    void api.getRunTrace(id).then(setData).catch(setError);
  }, [id]);

  if (!data) return error ? <ErrorNote error={error} /> : <Loading what="trace" />;

  const { run, spans } = data;
  const stats = traceStats(spans);
  const roots = spans.filter((span) => !span.parentId);
  const childrenOf = (parentId) => spans.filter((span) => span.parentId === parentId);

  const toggle = (spanId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  return (
    <section>
      <PageHeader
        eyebrow="Observe"
        title={
          <span className="flex items-center gap-3">
            Trace
            <StatusPill status={run.status} size="md" />
          </span>
        }
        description={`${run.agentName} · ${when(run.createdAt)}`}
        actions={
          <Button
            variant="bordered"
            radius="md"
            href={`/runs/${run.id}`}
            startContent={<Icon name="runs" className="h-4 w-4" />}
          >
            Open run record
          </Button>
        }
      />

      <ErrorNote error={error} />

      {run.error && (
        <div className="mb-4 rounded-medium border border-danger-200 bg-danger-50 px-4 py-3 text-tiny text-danger dark:border-danger-500/25 dark:bg-danger-500/10">
          <strong className="font-semibold">{run.error.code}: </strong>
          {run.error.message}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Duration" value={duration(stats.durationMs)} />
        <StatTile label="Spans" value={spans.length} detail={`${roots.length} model call(s)`} />
        <StatTile
          label="Tokens"
          value={stats.tokensTotal ? stats.tokensTotal.toLocaleString() : "—"}
          detail={
            stats.tokensTotal
              ? `${stats.tokensIn.toLocaleString()} in / ${stats.tokensOut.toLocaleString()} out`
              : undefined
          }
        />
        <StatTile label="Cost" value={stats.cost ? `$${stats.cost.toFixed(4)}` : "—"} />
      </div>

      <SectionCard
        title="Waterfall"
        description="A model call and the tool calls it made, positioned by when each one ran."
        bodyClassName="px-3 pb-4 pt-2"
      >
        {spans.length === 0 ? (
          <p className="px-2 py-6 text-center text-small text-default-500">
            No span data for this trace yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {roots.map((root) => (
              <div key={root.id} className="flex flex-col gap-1.5">
                <SpanRow
                  span={root}
                  windowStart={stats.windowStart}
                  windowMs={stats.windowMs}
                  isExpanded={expanded.has(root.id)}
                  onToggle={() => toggle(root.id)}
                />
                {childrenOf(root.id).map((child) => (
                  <div key={child.id} className="pl-6">
                    <SpanRow
                      span={child}
                      windowStart={stats.windowStart}
                      windowMs={stats.windowMs}
                      isExpanded={expanded.has(child.id)}
                      onToggle={() => toggle(child.id)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}

function SpanRow({ span, windowStart, windowMs, isExpanded, onToggle }) {
  const start = Date.parse(span.startedAt);
  const end = span.endedAt ? Date.parse(span.endedAt) : start;
  const leftPct = windowMs ? ((start - windowStart) / windowMs) * 100 : 0;
  const widthPct = windowMs ? Math.max(((end - start) / windowMs) * 100, 1) : 100;
  const isError = span.status === "error";
  const isGeneration = span.type === "generation";
  const barColor = isError ? "bg-danger" : isGeneration ? "bg-primary" : "bg-secondary";

  return (
    <div className="rounded-medium border border-transparent hover:border-divider">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-medium px-2 py-1.5 text-left hover:bg-content2"
      >
        <span className="w-36 shrink-0 truncate text-small font-medium text-foreground">
          {span.name}
        </span>
        <span className="relative h-5 flex-1">
          <span
            className={`absolute inset-y-0 rounded-full ${barColor}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          />
        </span>
        <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono text-tiny text-default-500">
          {duration(end - start)}
        </span>
        <Icon
          name="down"
          className={`h-3.5 w-3.5 shrink-0 text-default-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {isExpanded && (
        <div className="grid grid-cols-1 gap-3 px-2 pb-3 pt-1 md:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-default-500">
              Input
            </span>
            <ScrollShadow className="max-h-[180px] rounded-medium border border-divider bg-content2">
              <pre className="message-text p-2.5 font-mono text-tiny">
                {span.input || "(none)"}
              </pre>
            </ScrollShadow>
          </div>
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-default-500">
              Output
            </span>
            <ScrollShadow className="max-h-[180px] rounded-medium border border-divider bg-content2">
              <pre
                className={`message-text p-2.5 font-mono text-tiny ${isError ? "text-danger" : ""}`}
              >
                {span.output || "(none)"}
              </pre>
            </ScrollShadow>
          </div>
          {span.usage && (
            <div className="md:col-span-2">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-default-500">
                Usage
              </span>
              <pre className="code-scroll text-default-500">
                {JSON.stringify(span.usage, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Trace-level rollups derived client-side from the spans array. */
function traceStats(spans) {
  let windowStart = Infinity;
  let windowEnd = -Infinity;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;

  for (const span of spans) {
    const start = Date.parse(span.startedAt);
    const end = span.endedAt ? Date.parse(span.endedAt) : start;
    if (!Number.isNaN(start)) windowStart = Math.min(windowStart, start);
    if (!Number.isNaN(end)) windowEnd = Math.max(windowEnd, end);
    if (span.type === "generation" && span.usage) {
      tokensIn += span.usage.inputTokens ?? 0;
      tokensOut += span.usage.outputTokens ?? 0;
    }
    if (typeof span.cost?.amount === "number") cost += span.cost.amount;
  }

  const hasWindow = Number.isFinite(windowStart) && Number.isFinite(windowEnd);
  return {
    windowStart: hasWindow ? windowStart : 0,
    windowMs: hasWindow ? Math.max(windowEnd - windowStart, 1) : 0,
    durationMs: hasWindow ? windowEnd - windowStart : 0,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    cost,
  };
}
