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

export function TemplatesPage() {
  const [templates, setTemplates] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const { templates: found } = await api.listTemplates({ q });
      setTemplates(found);
    } catch (caught) {
      setError(caught);
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const visibleTemplates = useMemo(() => {
    if (!templates || !query.trim()) return templates;
    const needle = query.trim().toLowerCase();
    return templates.filter((template) =>
      [template.name, template.uri]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [templates, query]);
  const remove = async (template) => {
    const confirmed = await confirm({
      title: "Delete template",
      body: `Delete template "${template.name}"? Agents that reference it must be updated first.`,
      confirmLabel: "Delete template",
    });
    if (!confirmed) return;

    try {
      await api.deleteTemplate(template.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Build"
        title="Templates"
        description="Reusable text or Markdown documents stored in S3 and injected into assigned agents."
        actions={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              label="Search templates"
              placeholder="Search templates"
            />
            <Button
              as={Link}
              to="/templates/new"
              color="primary"
              radius="md"
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New template
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {templates === null ? (
        <Loading what="templates" />
      ) : visibleTemplates.length === 0 ? (
        <EmptyState
          icon="skills"
          title={query ? "No templates match this search." : "No templates found."}
          description={
            query
              ? "Try a different search."
              : "Upload a reusable text or Markdown template."
          }
          action={
            !query && (
              <Button as={Link} to="/templates/new" color="primary" radius="md">
                Create one
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visibleTemplates.map((template) => (
            <li key={template.id}>
              <ResourceRow
                title={template.name}
                editHref={`/templates/${template.id}/edit`}
                deleteLabel={`Delete ${template.name}`}
                onDelete={() => remove(template)}
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
                      {template.uri?.startsWith("s3://") ? "S3" : "HTTPS"}
                    </Chip>
                    <StatusPill status={template.enabled ? "enabled" : "disabled"} />
                  </>
                }
                summary={
                  <Code size="sm" className="max-w-full truncate text-tiny">
                    {template.uri}
                  </Code>
                }
                meta={[{ label: "Updated", value: when(template.updatedAt) }]}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmDialog}
    </section>
  );
}
