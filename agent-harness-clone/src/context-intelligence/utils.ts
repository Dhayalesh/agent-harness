import { createHash, randomUUID } from 'node:crypto';
import type { Provenance, SourceMetadata } from './contracts.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function now(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

export function estimateTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

export function terms(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_.:/\\-]+/u)
    .map((term) => term.replace(/^[_.:/\\-]+|[_.:/\\-]+$/g, ''))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

export function uniqueTerms(value: string): string[] {
  return [...new Set(terms(value))];
}

export function lexicalSimilarity(left: string, right: string): number {
  const a = new Set(uniqueTerms(left));
  const b = new Set(uniqueTerms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function containmentScore(query: string, candidate: string): number {
  const wanted = uniqueTerms(query);
  if (wanted.length === 0) return 0;
  const available = new Set(uniqueTerms(candidate));
  return wanted.filter((term) => available.has(term)).length / wanted.length;
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export function freshnessScore(
  timestamp: string | undefined,
  halfLifeMs: number,
  currentTime = Date.now(),
): number {
  if (!timestamp) return 0.5;
  const observed = Date.parse(timestamp);
  if (!Number.isFinite(observed)) return 0.25;
  const age = Math.max(0, currentTime - observed);
  return clamp(2 ** (-age / Math.max(1, halfLifeMs)));
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

export function sourceMetadata(
  partial: Pick<SourceMetadata, 'id' | 'name' | 'type'> & Partial<SourceMetadata>,
): SourceMetadata {
  return {
    id: partial.id,
    name: partial.name,
    type: partial.type,
    authority: clamp(partial.authority ?? 0.5),
    ...(partial.provider === undefined ? {} : { provider: partial.provider }),
    ...(partial.retrievedAt === undefined ? {} : { retrievedAt: partial.retrievedAt }),
    ...(partial.observedAt === undefined ? {} : { observedAt: partial.observedAt }),
    ...(partial.validFrom === undefined ? {} : { validFrom: partial.validFrom }),
    ...(partial.validUntil === undefined ? {} : { validUntil: partial.validUntil }),
    ...(partial.version === undefined ? {} : { version: partial.version }),
    ...(partial.scope === undefined ? {} : { scope: partial.scope }),
    ...(partial.uri === undefined ? {} : { uri: partial.uri }),
    ...(partial.contentHash === undefined ? {} : { contentHash: partial.contentHash }),
    ...(partial.policyLabels === undefined ? {} : { policyLabels: partial.policyLabels }),
  };
}

export function provenance(
  source: SourceMetadata,
  operation: Provenance['steps'][number]['operation'],
  component: string,
  inputIds: readonly string[] = [],
  details?: Readonly<Record<string, unknown>>,
): Provenance {
  const at = now();
  return {
    id: id('prov'),
    source,
    parentIds: [...inputIds],
    steps: [
      {
        operation,
        at,
        component,
        inputIds: [...inputIds],
        ...(details === undefined ? {} : { details }),
      },
    ],
  };
}

export function appendProvenance(
  value: Provenance,
  operation: Provenance['steps'][number]['operation'],
  component: string,
  inputIds: readonly string[],
  details?: Readonly<Record<string, unknown>>,
): Provenance {
  return {
    ...value,
    parentIds: dedupeStrings([...value.parentIds, ...inputIds]),
    steps: [
      ...value.steps,
      {
        operation,
        at: now(),
        component,
        inputIds: [...inputIds],
        ...(details === undefined ? {} : { details }),
      },
    ],
  };
}

export function parseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function preview(value: string, maximum = 500): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum)}…`;
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
