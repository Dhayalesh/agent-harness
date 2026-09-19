import { Field } from "./Bits.jsx";
import { Icon } from "./Icon.jsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Editors for the two shapes the API stores as opaque maps or lists: header and
 * environment maps, and a command's ordered arguments.
 *
 * Both are row editors rather than a JSON textarea because a mistyped brace in a
 * credential map is a support ticket, and because the PATCH contract treats a blank
 * value as "keep the stored one" — which only reads clearly next to its key.
 */

export const rowsFromSecretMap = (record, names) => {
  if (record) {
    return Object.entries(record).map(([key, value]) => ({ key, value }));
  }
  return (names ?? []).map((key) => ({ key, value: "" }));
};

export const secretMapFromRows = (rows) =>
  Object.fromEntries(
    rows
      .filter((row) => row.key.trim())
      .map((row) => [row.key.trim(), row.value]),
  );

export function KeyValueEditor({
  label,
  hint,
  addLabel,
  keyPlaceholder,
  rows,
  onChange,
  error,
  editing,
}) {
  const setRow = (index, key, value) =>
    onChange(
      rows.map((row, position) =>
        position === index ? { ...row, [key]: value } : row,
      ),
    );

  return (
    <Field
      label={label}
      error={error}
      hint={
        editing
          ? `${hint} Existing values are hidden; leave a displayed value blank to keep it, or remove its row to clear it.`
          : hint
      }
      className="border border-divider bg-content2 p-3"
    >
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div
            className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
            key={index}
          >
            <Input
              className="h-8 bg-content1"
              aria-label={`${label} ${index + 1} name`}
              placeholder={keyPlaceholder}
              value={row.key}
              onChange={(event) => setRow(index, "key", event.target.value)}
            />
            <Input
              className="h-8 bg-content1"
              aria-label={`${label} ${index + 1} value`}
              placeholder={
                editing && !row.value ? "stored value (unchanged)" : "Value"
              }
              value={row.value}
              onChange={(event) => setRow(index, "value", event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="justify-self-start text-default-500 hover:bg-danger/10 hover:text-danger sm:self-center"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              onClick={() =>
                onChange(rows.filter((_, position) => position !== index))
              }
            >
              <Icon name="trash" className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          <Icon name="plus" className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
    </Field>
  );
}

export function StringListEditor({ values, onChange, error }) {
  return (
    <Field
      label="Arguments"
      error={error}
      hint="Each row is passed to the command as one argument, in order. For example, npx uses separate rows for -y, @scope/package, and --transport=stdio. Put an MCP endpoint URL under HTTP transport instead of in npx's package row."
      className="border border-divider bg-content2 p-3"
    >
      <div className="flex flex-col gap-2">
        {values.map((value, index) => (
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
            key={index}
          >
            <Input
              className="h-8 bg-content1"
              aria-label={`Argument ${index + 1}`}
              value={value}
              onChange={(event) =>
                onChange(
                  values.map((entry, position) =>
                    position === index ? event.target.value : entry,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="self-center text-default-500 hover:bg-danger/10 hover:text-danger"
              aria-label={`Remove argument ${index + 1}`}
              onClick={() =>
                onChange(values.filter((_, position) => position !== index))
              }
            >
              <Icon name="trash" className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={() => onChange([...values, ""])}
        >
          <Icon name="plus" className="h-4 w-4" />
          Add argument
        </Button>
      </div>
    </Field>
  );
}
