import { Button, Chip, Code } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  SearchInput,
  StatusPill,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";
import { ResourceRow } from "../components/ResourceRow.jsx";

export function ModelProvidersPage() {
  const [modelProviders, setModelProviders] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const { modelProviders: found } = await api.listModelProviders({ q });
      setModelProviders(found);
    } catch (caught) {
      setError(caught);
      setModelProviders([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // The API may implement q server-side; filtering again keeps search functional
  // against older console servers that simply return the whole collection.
  const visibleModelProviders = useMemo(() => {
    if (!modelProviders || !query.trim()) return modelProviders;
    const needle = query.trim().toLowerCase();
    return modelProviders.filter((modelProvider) =>
      [modelProvider.name, modelProvider.provider, modelProvider.model]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [modelProviders, query]);

  const remove = async (modelProvider) => {
    const confirmed = await confirm({
      title: "Delete model provider",
      body: `Delete model provider "${modelProvider.name}"? Agents that reference it must be updated first.`,
      confirmLabel: "Delete provider",
    });
    if (!confirmed) return;

    try {
      await api.deleteModelProvider(modelProvider.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Build"
        title="Model providers"
        description="Reusable model endpoints and capability limits sent to the AgentCore runtime with an invocation."
        actions={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              label="Search model providers"
              placeholder="Search providers"
            />
            <Button
              as={Link}
              to="/model-providers/new"
              color="primary"
              radius="md"
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New provider
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {modelProviders === null ? (
        <Loading what="model providers" />
      ) : visibleModelProviders.length === 0 ? (
        <EmptyState
          icon="models"
          title={
            query
              ? "No model providers match this search."
              : "No model providers found."
          }
          description={
            query
              ? "Try a different search."
              : "Connect a model before composing an agent."
          }
          action={
            !query && (
              <Button
                as={Link}
                to="/model-providers/new"
                color="primary"
                radius="md"
              >
                Create one
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visibleModelProviders.map((modelProvider) => (
            <li key={modelProvider.id}>
              <ResourceRow
                title={modelProvider.name}
                editHref={`/model-providers/${modelProvider.id}/edit`}
                deleteLabel={`Delete ${modelProvider.name}`}
                onDelete={() => remove(modelProvider)}
                badges={
                  <>
                    <Chip
                      size="sm"
                      variant="flat"
                      color="primary"
                      classNames={{
                        base: "h-5 rounded-full",
                        content:
                          "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
                      }}
                    >
                      {modelProvider.provider}
                    </Chip>
                    <StatusPill
                      status={modelProvider.enabled ? "enabled" : "disabled"}
                    />
                    {modelProvider.isDefault && <StatusPill status="default" />}
                  </>
                }
                summary={
                  <>
                    <Code size="sm" className="text-tiny">
                      {modelProvider.model}
                    </Code>
                    {" via "}
                    {modelProvider.baseURL || "no endpoint configured"}
                  </>
                }
                meta={[
                  {
                    label: "Context",
                    value: `${
                      modelProvider.capabilities?.contextWindow?.toLocaleString() ??
                      "-"
                    } tokens`,
                  },
                  {
                    label: "Max output",
                    value: `${
                      modelProvider.capabilities?.maxOutputTokens?.toLocaleString() ??
                      "-"
                    } tokens`,
                  },
                  {
                    label: "Credential",
                    value: modelProvider.hasApiKey ? "configured" : "missing",
                  },
                  { label: "Updated", value: when(modelProvider.updatedAt) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmDialog}
    </section>
  );
}

