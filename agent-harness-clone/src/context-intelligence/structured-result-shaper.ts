import { stableHash } from './utils.js';

export type StructuredRecord = Readonly<Record<string, unknown>>;
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';
export type StructuredFilter = {
  field: string;
  operator: FilterOperator;
  value?: unknown;
};

export type AggregationSpec = {
  field?: string;
  operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum' | 'distinct-count';
  as: string;
};

export type StructuredShapeRequest = {
  projection?: readonly string[];
  filters?: readonly StructuredFilter[];
  groupBy?: readonly string[];
  aggregations?: readonly AggregationSpec[];
  sort?: readonly { field: string; direction: 'asc' | 'desc' }[];
  page?: number;
  pageSize?: number;
  identifierFields?: readonly string[];
  parentField?: string;
  exceptionFilters?: readonly StructuredFilter[];
  maximumRows?: number;
};

export type FieldProfile = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null' | 'mixed';
  nullable: boolean;
  distinctCount: number;
};

export type StructuredShapeResult = {
  rows: readonly StructuredRecord[];
  populationCount: number;
  filteredCount: number;
  returnedCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  totals: Readonly<Record<string, number>>;
  exceptions: readonly StructuredRecord[];
  fieldProfiles: readonly FieldProfile[];
  identifiers: readonly string[];
  relationships: readonly { parent: string; children: readonly string[] }[];
  drillDown: {
    resultHash: string;
    omittedRows: number;
    nextPage?: number;
    filters: readonly StructuredFilter[];
  };
};

export class StructuredResultShaper {
  shape(input: unknown, request: StructuredShapeRequest = {}): StructuredShapeResult {
    const source = recordsOf(input);
    const maximumRows = Math.max(1, request.maximumRows ?? 100);
    const pageSize = Math.min(maximumRows, Math.max(1, request.pageSize ?? 25));
    const page = Math.max(1, request.page ?? 1);
    const filtered = source.filter((record) => matchesAll(record, request.filters ?? []));
    const grouped = request.groupBy?.length
      ? groupRecords(filtered, request.groupBy, request.aggregations ?? [{ operation: 'count', as: 'count' }])
      : filtered;
    const sorted = sortRecords(grouped, request.sort ?? []);
    const offset = (page - 1) * pageSize;
    const selected = sorted.slice(offset, offset + pageSize);
    const rows = selected.map((record) => projectRecord(record, request.projection));
    const identifiers = extractIdentifiers(rows, request.identifierFields ?? inferIdentifierFields(source));
    const relationships = relationshipIndex(source, request.parentField, request.identifierFields?.[0]);
    const exceptions = request.exceptionFilters?.length
      ? source
          .filter((record) => matchesAll(record, request.exceptionFilters ?? []))
          .slice(0, Math.min(25, maximumRows))
          .map((record) => projectRecord(record, request.projection))
      : [];
    const totals = calculateTotals(filtered, request.aggregations ?? []);
    const pageCount = Math.ceil(grouped.length / pageSize);
    const nextPage = page < pageCount ? page + 1 : undefined;
    return {
      rows,
      populationCount: populationOf(input, source.length),
      filteredCount: filtered.length,
      returnedCount: rows.length,
      page,
      pageSize,
      pageCount,
      totals,
      exceptions,
      fieldProfiles: profileFields(source),
      identifiers,
      relationships,
      drillDown: {
        resultHash: stableHash(input),
        omittedRows: Math.max(0, grouped.length - rows.length),
        ...(nextPage === undefined ? {} : { nextPage }),
        filters: [...(request.filters ?? [])],
      },
    };
  }
}

function populationOf(input: unknown, fallback: number): number {
  if (!isRecord(input)) return fallback;
  for (const key of ['populationCount', 'totalCount', 'total', 'count']) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= fallback) return value;
  }
  return fallback;
}

function recordsOf(input: unknown): StructuredRecord[] {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (!isRecord(input)) return [];
  for (const key of ['rows', 'items', 'results', 'records', 'data', 'value']) {
    const candidate = input[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [input];
}

function isRecord(value: unknown): value is StructuredRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function valueAt(record: StructuredRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), record);
}

function matchesAll(record: StructuredRecord, filters: readonly StructuredFilter[]): boolean {
  return filters.every((filter) => matches(valueAt(record, filter.field), filter));
}

function matches(value: unknown, filter: StructuredFilter): boolean {
  switch (filter.operator) {
    case 'eq':
      return comparable(value) === comparable(filter.value);
    case 'ne':
      return comparable(value) !== comparable(filter.value);
    case 'gt':
      return compare(value, filter.value) > 0;
    case 'gte':
      return compare(value, filter.value) >= 0;
    case 'lt':
      return compare(value, filter.value) < 0;
    case 'lte':
      return compare(value, filter.value) <= 0;
    case 'in':
      return Array.isArray(filter.value) && filter.value.map(comparable).includes(comparable(value));
    case 'contains':
      return Array.isArray(value)
        ? value.map(comparable).includes(comparable(filter.value))
        : String(value ?? '').toLowerCase().includes(String(filter.value ?? '').toLowerCase());
    case 'exists':
      return filter.value === false ? value === undefined || value === null : value !== undefined && value !== null;
  }
}

function comparable(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

function compare(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}

function projectRecord(record: StructuredRecord, projection?: readonly string[]): StructuredRecord {
  if (!projection?.length) return structuredClone(record);
  return Object.fromEntries(projection.map((field) => [field, valueAt(record, field)]));
}

function groupRecords(
  records: readonly StructuredRecord[],
  groupBy: readonly string[],
  aggregations: readonly AggregationSpec[],
): StructuredRecord[] {
  const groups = new Map<string, StructuredRecord[]>();
  for (const record of records) {
    const key = JSON.stringify(groupBy.map((field) => valueAt(record, field)));
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([serialized, group]) => {
    const keyValues = JSON.parse(serialized) as unknown[];
    return {
      ...Object.fromEntries(groupBy.map((field, index) => [field, keyValues[index]])),
      ...Object.fromEntries(aggregations.map((aggregation) => [aggregation.as, aggregate(group, aggregation)])),
    };
  });
}

function aggregate(records: readonly StructuredRecord[], spec: AggregationSpec): number {
  if (spec.operation === 'count') return records.length;
  const values = records.map((record) => valueAt(record, spec.field ?? '')).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (spec.operation === 'distinct-count') {
    return new Set(records.map((record) => comparable(valueAt(record, spec.field ?? '')))).size;
  }
  if (values.length === 0) return 0;
  if (spec.operation === 'sum') return values.reduce((sum, value) => sum + value, 0);
  if (spec.operation === 'average') return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (spec.operation === 'minimum') return Math.min(...values);
  return Math.max(...values);
}

function calculateTotals(
  records: readonly StructuredRecord[],
  aggregations: readonly AggregationSpec[],
): Record<string, number> {
  return Object.fromEntries(aggregations.map((spec) => [spec.as, aggregate(records, spec)]));
}

function sortRecords(
  records: readonly StructuredRecord[],
  sort: readonly { field: string; direction: 'asc' | 'desc' }[],
): StructuredRecord[] {
  return [...records].sort((left, right) => {
    for (const rule of sort) {
      const result = compare(valueAt(left, rule.field), valueAt(right, rule.field));
      if (result !== 0) return rule.direction === 'asc' ? result : -result;
    }
    return 0;
  });
}

function inferIdentifierFields(records: readonly StructuredRecord[]): string[] {
  const first = records[0];
  if (!first) return [];
  return Object.keys(first).filter((key) => /(^id$|id$|identifier|key|uuid|code)$/i.test(key)).slice(0, 5);
}

function extractIdentifiers(records: readonly StructuredRecord[], fields: readonly string[]): string[] {
  return [...new Set(records.flatMap((record) => fields.map((field) => valueAt(record, field)).filter((value) => value !== undefined && value !== null).map(String)))];
}

function relationshipIndex(
  records: readonly StructuredRecord[],
  parentField: string | undefined,
  identifierField: string | undefined,
): { parent: string; children: readonly string[] }[] {
  if (!parentField || !identifierField) return [];
  const groups = new Map<string, string[]>();
  for (const record of records) {
    const parent = valueAt(record, parentField);
    const child = valueAt(record, identifierField);
    if (parent === undefined || parent === null || child === undefined || child === null) continue;
    const key = String(parent);
    const children = groups.get(key) ?? [];
    children.push(String(child));
    groups.set(key, children);
  }
  return [...groups.entries()].map(([parent, children]) => ({ parent, children: [...new Set(children)] }));
}

function profileFields(records: readonly StructuredRecord[]): FieldProfile[] {
  const names = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return names.map((name) => {
    const values = records.map((record) => record[name]);
    const types = new Set(values.map(typeOf));
    const nonNullTypes = [...types].filter((type) => type !== 'null');
    return {
      name,
      type: nonNullTypes.length === 1 ? nonNullTypes[0]! : nonNullTypes.length === 0 ? 'null' : 'mixed',
      nullable: types.has('null'),
      distinctCount: new Set(values.map((value) => JSON.stringify(value))).size,
    };
  });
}

function typeOf(value: unknown): FieldProfile['type'] {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return 'date';
  return 'string';
}
