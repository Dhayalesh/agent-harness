import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  MonoValue,
  SectionCard,
  StatusPill,
  duration,
  tokens,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageShell, PageTabs } from "../components/PageShell.jsx";
import { SkeletonPanels, SkeletonStats } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Snippet } from "@/components/ui/snippet";

/**
 * One run, read as a report.
 *
 * The previous version stacked six panels in a single column, so the transcript and
 * the token JSON — the two things you only look at deliberately — pushed the
 * metadata you always want off the top of the screen. The defining numbers are now
 * in the header strip, and the bulky content is behind tabs.
 */
export function RunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("transcript");
  const [confirm, confirmDialog] = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    void api
      .getRun(id)
      .then(({ run: found }) => setRun(found))
      .catch(setError);
  }, [id]);

  const toolColumns = useMemo(
    () => [
      {
        key: "name",
        header: "Tool",
        sortable: true,
        value: (tool) => tool.name,
        render: (tool) => <MonoValue>{tool.name}</MonoValue>,
      },
      {
        key: "calls",
        header: "Calls",
        sortable: true,
        numeric: true,
        width: "100px",
        value: (tool) => tool.calls,
      },
      {
        key: "errors",
        header: "Errors",
        sortable: true,
        numeric: true,
        width: "100px",
        value: (tool) => tool.errors,
        render: (tool) => (
          <span className={tool.errors ? "font-semibold text-danger" : ""}>
            {tool.errors}
          </span>
        ),
      },
    ],
    [],
  );

  if (!run) {
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="flex flex-col gap-4">
        <SkeletonStats />
        <SkeletonPanels count={2} />
      </div>
    );
  }

  const remove = async () => {
    const confirmed = await confirm({
      title: "Delete run record",
      body: "Delete this run record? The prompt, output, and usage stored on it are removed.",
      confirmLabel: "Delete run",
    });
    if (!confirmed) return;
    try {
      await api.deleteRun(id);
      toast({ title: "Run deleted" });
      navigate("/runs");
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not delete run",
        description: caught.message,
        tone: "danger",
      });
    }
  };

  const tabs = [
    { key: "transcript", label: "Transcript", icon: "chat" },
    {
      key: "tools",
      label: "Tools",
      icon: "tool",
      count: run.tools?.length ?? 0,
    },
    { key: "metadata", label: "Runtime", icon: "settings" },
    { key: "usage", label: "Token detail", icon: "tokens" },
  ];

  return (
    <PageShell
      breadcrumbs={[
        { label: "Operations" },
        { label: "Runs", to: "/runs" },
        { label: run.agentName ?? "Run" },
      ]}
      title={run.agentName ?? "Run"}
      status={<StatusPill status={run.status} />}
      description={when(run.createdAt)}
      actions={
        <>
          <Button asChild variant="outline" className="border-divider">
            <Link to={`/agents/${run.agentId}`}>
              <Icon name="agents" className="h-4 w-4" />
              Open agent
            </Link>
          </Button>
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger/10 hover:text-danger"
            onClick={remove}
          >
            <Icon name="trash" className="h-4 w-4" />
            Delete
          </Button>
        </>
      }
      meta={[
        { label: "Turns", value: run.turns ?? "—", numeric: true },
        { label: "Tokens", value: tokens(run.usage), numeric: true },
        { label: "Duration", value: duration(run.durationMs), numeric: true },
        { label: "Stop reason", value: run.stopReason ?? "—" },
      ]}
      tabs={<PageTabs tabs={tabs} activeKey={tab} onChange={setTab} />}
    >
      <ErrorNote error={error} />

      {run.error && (
        <Alert variant="warning" className="mb-4">
          <Icon name="alert" />
          <div className="min-w-0 flex-1">
            <AlertTitle>{run.error.code}</AlertTitle>
            <AlertDescription>
              {run.error.message}
              {run.error.recoverable ? " (recoverable)" : ""}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {tab === "transcript" && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <SectionCard title="Prompt" bodyClassName="p-0">
            <TextPane>{run.prompt}</TextPane>
          </SectionCard>
          <SectionCard title="Output" bodyClassName="p-0">
            <TextPane>{run.output || "(no text output)"}</TextPane>
          </SectionCard>
        </div>
      )}

      {tab === "tools" && (
        <DataTable
          caption="Tool usage"
          columns={toolColumns}
          rows={run.tools ?? []}
          rowKey={(tool) => tool.name}
          defaultSort={{ key: "calls", dir: "desc" }}
          totalLabel="tools"
          maxHeight="none"
          empty={
            <p className="py-6 text-center text-small text-default-500">
              No tools were called during this run.
            </p>
          }
        />
      )}

      {tab === "metadata" && (
        <SectionCard
          title="AgentCore metadata"
          description="What identified this invocation at the runtime."
        >
          <dl className="flex flex-col">
            <IdRow label="Runtime session id" value={run.runtimeSessionId} />
            <IdRow label="Trace id" value={run.traceId} />
            <IdRow label="Runtime ARN" value={run.agentRuntimeArn} />
            <IdRow
              label="Qualifier"
              value={run.agentRuntimeQualifier}
              copy={false}
            />
            <IdRow label="Workspace" value={run.workingDirectory} />
          </dl>
        </SectionCard>
      )}

      {tab === "usage" && (
        <SectionCard
          title="Token detail"
          description="The usage record exactly as it was stored."
          bodyClassName="p-0"
        >
          <ScrollArea className="max-h-[520px]">
            <pre className="code-scroll text-default-600">
              {JSON.stringify(run.usage ?? {}, null, 2)}
            </pre>
          </ScrollArea>
        </SectionCard>
      )}

      {confirmDialog}
    </PageShell>
  );
}

function TextPane({ children }) {
  return (
    <ScrollArea className="max-h-[420px]">
      <pre className="message-text p-4 font-mono text-tiny">{children}</pre>
    </ScrollArea>
  );
}

/**
 * Identifiers here are long and get pasted into AWS consoles, so make copying cheap
 * rather than making the reader select a truncated string by hand.
 */
function IdRow({ label, value, copy = true }) {
  return (
    <div className="flex flex-col gap-1 border-b border-divider py-2.5 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-full shrink-0 text-tiny font-medium text-default-500 sm:w-[170px]">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">
        {!value ? (
          <span className="text-small text-default-400">—</span>
        ) : copy ? (
          <Snippet value={value} className="max-w-full">
            {value}
          </Snippet>
        ) : (
          <MonoValue>{value}</MonoValue>
        )}
      </dd>
    </div>
  );
}
