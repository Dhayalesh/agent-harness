import { Button, Card, CardBody, Divider } from "@heroui/react";
import { Link } from "react-router-dom";
import { MetaGrid } from "./Bits.jsx";
import { Icon } from "./Icon.jsx";

/**
 * Model providers, MCP servers, and skills are three different records that a
 * reader scans the same way: name, state badges, the endpoint it points at, then
 * a few facts. One row component keeps that reading order identical everywhere.
 */
export function ResourceRow({
  title,
  badges,
  summary,
  meta,
  editHref,
  onDelete,
  deleteLabel,
}) {
  return (
    <Card
      shadow="none"
      className="border border-divider bg-content1 transition-colors hover:border-primary/30"
    >
      <CardBody className="flex-col gap-0 p-0 sm:flex-row">
        <div className="min-w-0 flex-1 p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="truncate text-medium font-semibold text-foreground">
              {title}
            </h2>
            <div className="flex flex-wrap items-center gap-1">{badges}</div>
          </div>

          {summary && (
            <p className="mt-2 truncate text-small text-default-500">
              {summary}
            </p>
          )}

          {meta?.length > 0 && <MetaGrid wide items={meta} className="mt-3.5" />}
        </div>

        <Divider className="sm:hidden" />
        <Divider orientation="vertical" className="hidden h-auto sm:block" />

        <div className="flex shrink-0 flex-row items-center justify-start gap-1 p-3 sm:w-[128px] sm:flex-col sm:justify-center">
          <Button
            as={Link}
            to={editHref}
            size="sm"
            variant="light"
            className="sm:w-full"
            startContent={<Icon name="edit" className="h-4 w-4" />}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="light"
            color="danger"
            className="sm:w-full"
            aria-label={deleteLabel}
            onPress={onDelete}
            startContent={<Icon name="trash" className="h-4 w-4" />}
          >
            Delete
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
