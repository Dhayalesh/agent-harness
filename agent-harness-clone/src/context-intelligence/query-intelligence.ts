import type { ContextIntelligenceConfig } from './config.js';
import type { NormalizedIntent, QueryPlan, QueryVariant, RetrievalResult } from './contracts.js';
import { dedupeStrings, id, lexicalSimilarity, now, uniqueTerms } from './utils.js';

export interface QueryTransformer {
  transform(
    operation: 'rewrite' | 'expand' | 'decompose' | 'refine',
    request: string,
    intent: NormalizedIntent,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}

export class IntentResolver {
  resolve(rawRequest: string): NormalizedIntent {
    const originalRequest = rawRequest.trim();
    const instructionSegments = segmentRequest(originalRequest);
    const informationText = instructionSegments.informationRequirements.join(' ').trim();
    const normalizedRequest = normalizeQuery(informationText || instructionSegments.userIntent);
    const entities = extractEntities(normalizedRequest);
    const constraints = extractConstraints(
      [...instructionSegments.taskInstructions, originalRequest].join('\n'),
    );
    const temporal = extractTemporal(normalizedRequest);
    const clauses = splitClauses(normalizedRequest);
    const ambiguity: string[] = [];
    if (normalizedRequest.length < 4)
      ambiguity.push('The request is too short to establish intent.');
    if (/\b(it|that|this|they|them|there)\b/i.test(normalizedRequest) && entities.length === 0) {
      ambiguity.push('The request contains an unresolved reference.');
    }
    const requestedOutput = extractRequestedOutput(
      instructionSegments.formattingInstructions.join(' ') || originalRequest,
    );
    const confidence = Math.max(
      0.2,
      Math.min(
        1,
        0.55 + entities.length * 0.05 + constraints.length * 0.04 - ambiguity.length * 0.2,
      ),
    );
    return {
      originalRequest,
      normalizedRequest,
      goal: firstGoalClause(normalizedRequest),
      operation: detectOperation(instructionSegments.userIntent || originalRequest),
      ...(requestedOutput === undefined ? {} : { requestedOutput }),
      entities,
      constraints,
      ...(temporal === undefined ? {} : { temporal }),
      ambiguity,
      keywords: uniqueTerms(normalizedRequest).slice(0, 40),
      complexity: clauses.length >= 4 ? 'complex' : clauses.length >= 2 ? 'compound' : 'simple',
      confidence,
      instructionSegments,
    };
  }
}

export class QueryIntelligence {
  constructor(
    private readonly config: ContextIntelligenceConfig['query'],
    private readonly transformer?: QueryTransformer,
    private readonly intentResolver = new IntentResolver(),
  ) {}

  understand(request: string): NormalizedIntent {
    return this.intentResolver.resolve(request);
  }

  async plan(request: string, signal: AbortSignal): Promise<QueryPlan> {
    const intent = this.understand(request);
    const rootId = id('query');
    const original: QueryVariant = {
      id: rootId,
      original: request,
      query: intent.normalizedRequest,
      kind: 'original',
      dependencyIds: [],
      expectedEvidence: expectedEvidence(intent),
      sourceHints: [],
      status: 'pending',
      resultIds: [],
      attempts: 0,
    };

    const rewritten = await this.rewrite(intent, signal);
    const rewriteVariants = rewritten
      .filter((value) => normalizeQuery(value) !== intent.normalizedRequest)
      .slice(0, 1)
      .map((query) => variant(query, 'rewrite', request, rootId, []));
    const expansionBase = rewriteVariants[0]?.query ?? original.query;
    const expansions = await this.expand(expansionBase, intent, signal);
    const expansionVariants = expansions
      .filter((value) => normalizeQuery(value) !== normalizeQuery(expansionBase))
      .slice(0, this.config.maximumExpansions)
      .map((query) => variant(query, 'expansion', request, rewriteVariants[0]?.id ?? rootId, []));
    const decomposed = await this.decompose(intent, signal);
    const subqueries: QueryVariant[] = [];
    for (const query of decomposed.slice(0, this.config.maximumSubqueries)) {
      const previous = subqueries[subqueries.length - 1];
      subqueries.push(
        variant(
          query,
          'subquery',
          request,
          rewriteVariants[0]?.id ?? rootId,
          previous ? [previous.id] : [],
        ),
      );
    }
    const variants = dedupeVariants([
      original,
      ...rewriteVariants,
      ...expansionVariants,
      ...subqueries,
    ]);
    return {
      id: id('query_plan'),
      originalRequest: request,
      normalizedQuery: intent.normalizedRequest,
      variants,
      synthesisOrder: variants
        .filter((entry) => entry.kind === 'subquery')
        .map((entry) => entry.id),
      createdAt: now(),
    };
  }

  async refine(
    query: QueryVariant,
    intent: NormalizedIntent,
    insufficiencies: readonly string[],
    signal: AbortSignal,
  ): Promise<QueryVariant> {
    const external = await this.transformer?.transform('refine', query.query, intent, signal);
    const additions = insufficiencies
      .flatMap(uniqueTerms)
      .filter((term) => !new Set(uniqueTerms(query.query)).has(term))
      .slice(0, 8);
    const candidate = external?.find((value) => preservesLockedValues(value, intent));
    const refined = normalizeQuery(candidate ?? `${query.query} ${additions.join(' ')}`);
    return {
      ...variant(refined, 'refinement', query.original, query.id, query.dependencyIds),
      attempts: query.attempts + 1,
    };
  }

  synthesize(plan: QueryPlan, results: readonly RetrievalResult[]): string {
    if (results.length === 0) return 'No retrieval evidence was available.';
    const byQuery = new Map<string, RetrievalResult[]>();
    for (const result of results) {
      const group = byQuery.get(result.queryId) ?? [];
      group.push(result);
      byQuery.set(result.queryId, group);
    }
    const orderedIds = plan.synthesisOrder.length > 0 ? plan.synthesisOrder : [...byQuery.keys()];
    return orderedIds
      .flatMap((queryId) => {
        const query = plan.variants.find((entry) => entry.id === queryId)?.query ?? queryId;
        const entries = byQuery.get(queryId) ?? [];
        if (entries.length === 0) return [];
        return [`### ${query}`, ...entries.map((entry) => `- ${entry.content} [${entry.id}]`)];
      })
      .join('\n');
  }

  private async rewrite(intent: NormalizedIntent, signal: AbortSignal): Promise<readonly string[]> {
    const external = await this.transformer?.transform(
      'rewrite',
      intent.instructionSegments.userIntent,
      intent,
      signal,
    );
    if (external?.length)
      return external
        .map(cleanInformationRequirement)
        .filter((entry) => entry.length > 0 && preservesLockedValues(entry, intent));
    if (intent.normalizedRequest.length < this.config.minimumRewriteLength)
      return [intent.normalizedRequest];
    return [normalizeQuery(`${intent.goal} ${intent.constraints.join(' ')}`)];
  }

  private async expand(
    query: string,
    intent: NormalizedIntent,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const external = await this.transformer?.transform('expand', query, intent, signal);
    const aliases: string[] = [];
    for (const term of uniqueTerms(query)) {
      for (const alias of this.config.aliases[term] ?? []) {
        aliases.push(normalizeQuery(`${query} ${alias}`));
      }
    }
    return dedupeStrings([
      ...(external ?? []).filter((entry) => preservesLockedValues(entry, intent)),
      ...aliases,
    ]);
  }

  private async decompose(
    intent: NormalizedIntent,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const external = await this.transformer?.transform(
      'decompose',
      intent.instructionSegments.informationRequirements.join('; '),
      intent,
      signal,
    );
    if (external?.length) {
      return external
        .map(cleanInformationRequirement)
        .filter((entry) => entry.length > 0 && preservesLockedValues(entry, intent));
    }
    if (intent.complexity === 'simple') return [];
    return intent.instructionSegments.informationRequirements
      .flatMap(splitClauses)
      .filter((entry) => uniqueTerms(entry).length >= 2);
  }
}

function variant(
  query: string,
  kind: QueryVariant['kind'],
  original: string,
  parentId: string,
  dependencyIds: readonly string[],
): QueryVariant {
  return {
    id: id('query'),
    parentId,
    original,
    query: normalizeQuery(query),
    kind,
    dependencyIds: [...dependencyIds],
    expectedEvidence: [],
    sourceHints: [],
    status: 'pending',
    resultIds: [],
    attempts: 0,
  };
}

function dedupeVariants(values: readonly QueryVariant[]): QueryVariant[] {
  const output: QueryVariant[] = [];
  for (const value of values) {
    if (output.some((entry) => lexicalSimilarity(entry.query, value.query) > 0.96)) continue;
    output.push(value);
  }
  return output;
}

function segmentRequest(value: string): NormalizedIntent['instructionSegments'] {
  const withoutControlBlocks = value
    .replace(
      /<(?:system|developer|tools?|tool_instructions|environment_context|test_prompt)[^>]*>[\s\S]*?<\/(?:system|developer|tools?|tool_instructions|environment_context|test_prompt)>/gi,
      ' ',
    )
    .replace(/<\/?(?:attached_files|context_entry|environment_context)[^>]*>/gi, ' ');
  const clauses = dedupeStrings(
    withoutControlBlocks
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map((entry) => entry.replace(/^\s*(?:[-*•]+|\d+[.)]|#{1,6})\s*/, '').trim())
      .filter(Boolean),
  ).slice(0, 200);
  const taskInstructions: string[] = [];
  const retrievalInstructions: string[] = [];
  const systemToolInstructions: string[] = [];
  const formattingInstructions: string[] = [];
  const informationRequirements: string[] = [];

  for (const clause of clauses) {
    if (isSystemToolInstruction(clause)) {
      systemToolInstructions.push(clause);
      continue;
    }
    if (isFormattingInstruction(clause)) {
      formattingInstructions.push(clause);
      const subject = cleanInformationRequirement(clause);
      if (subject) informationRequirements.push(subject);
      continue;
    }
    if (isRetrievalInstruction(clause)) {
      retrievalInstructions.push(clause);
      const subject = cleanInformationRequirement(clause);
      if (subject) informationRequirements.push(subject);
      continue;
    }
    if (isTaskInstruction(clause)) {
      taskInstructions.push(clause);
      continue;
    }
    const subject = cleanInformationRequirement(clause);
    if (subject) informationRequirements.push(subject);
  }

  const boundedRequirements = dedupeStrings(informationRequirements)
    .filter((entry) => entry.length >= 2)
    .slice(0, 12);
  const fallback = cleanInformationRequirement(
    clauses.find((clause) => !isSystemToolInstruction(clause)) ?? value,
  );
  const requirements = boundedRequirements.length > 0 ? boundedRequirements : [fallback].filter(Boolean);
  const userIntent = normalizeQuery(requirements.join('; ').slice(0, 4_000));
  return {
    userIntent,
    taskInstructions: dedupeStrings(taskInstructions).slice(0, 50),
    retrievalInstructions: dedupeStrings(retrievalInstructions).slice(0, 30),
    systemToolInstructions: dedupeStrings(systemToolInstructions).slice(0, 30),
    formattingInstructions: dedupeStrings(formattingInstructions).slice(0, 30),
    informationRequirements: requirements.map((entry) => normalizeQuery(entry).slice(0, 1_000)),
  };
}

function cleanInformationRequirement(value: string): string {
  return normalizeQuery(
    value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\b(?:please\s+)?(?:find|search(?:\s+for)?|look\s+up|browse(?:\s+for)?|retrieve|fetch|tell\s+me|show\s+me|give\s+me)\b\s*/i, '')
      .replace(
        /\s+(?:and\s+)?(?:return|respond|format|present|output|write)\b[\s\S]*$/i,
        ' ',
      )
      .replace(
        /\s+(?:using|via|with)\s+(?:the\s+)?(?:web|internet|browser|search|available\s+tools?|mcp\s+tools?)[\s\S]*$/i,
        ' ',
      )
      .replace(/\b(?:cite|include)\s+(?:the\s+)?sources?\b/gi, ' ')
      .replace(/\s+/g, ' '),
  ).slice(0, 1_000);
}

function isSystemToolInstruction(value: string): boolean {
  return /\b(system prompt|developer instructions?|tool instructions?|available tools?|tool registry|permission mode|authorization policy|test harness|execution prompt|ignore previous|chain[- ]of[- ]thought)\b/i.test(
    value,
  ) ||
    /^(?:context entry|environment context|instructions?|rules?|non-negotiable|acceptance criteria)\s*:?$/i.test(
      value,
    ) ||
    /^(?:scenario|test case|expected|actual|incorrect|correct|failure|invariant|validation|example)\s*\d*\s*:/i.test(
      value,
    ) ||
    /^(?:expected|actual|never|must not)\s*(?:→|->|:)/i.test(value);
}

function isFormattingInstruction(value: string): boolean {
  return /\b(?:return|respond|format|present|output|render|write)\b.{0,80}\b(?:json|csv|table|list|report|summary|markdown|document|xml|yaml|bullet|code block)\b/i.test(
    value,
  );
}

function isRetrievalInstruction(value: string): boolean {
  return /\b(?:search|browse|look\s+up|retrieve|fetch|verify|cite|source)\b.{0,80}\b(?:web|internet|online|official|source|documentation|database|api|mcp)\b/i.test(
    value,
  );
}

function isTaskInstruction(value: string): boolean {
  return /^(?:must|never|only|ensure|do not|don't|without|before|after|limit|maximum|minimum)\b/i.test(
    value,
  ) || /\b(?:do not run tests|no test execution|do not clone|preserve backward compatibility)\b/i.test(value);
}

function normalizeQuery(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitClauses(value: string): string[] {
  return dedupeStrings(
    value
      .replace(/\b(and then|then|also|additionally|furthermore)\b/gi, ';')
      .split(
        /(?:[;\n]|\s+\band\b\s+(?=(?:compare|find|show|explain|analy[sz]e|create|update|list|check)\b))/i,
      ),
  );
}

function extractEntities(value: string): NormalizedIntent['entities'] {
  const matches = [
    ...(value.match(
      /"[^"]+"|'[^']+'|\b[A-Z]{2,}[A-Z0-9_.-]*\b|\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z]+:\/\/\S+/g,
    ) ?? []),
  ];
  return dedupeStrings(matches)
    .slice(0, 30)
    .map((match) => ({
      name: match.replace(/^['"]|['"]$/g, ''),
      value: match.replace(/^['"]|['"]$/g, ''),
      type: /^\d{4}-\d{2}-\d{2}$/.test(match)
        ? 'date'
        : match.includes('://')
          ? 'uri'
          : 'identifier',
      required: true,
      confidence: 0.9,
    }));
}

function extractConstraints(value: string): string[] {
  return dedupeStrings(
    value
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) =>
        /\b(must|only|never|without|before|after|within|at most|at least|do not|don't|exclude|include|limit|format)\b/i.test(
          sentence,
        ),
      ),
  ).slice(0, 20);
}

function extractTemporal(value: string): NormalizedIntent['temporal'] | undefined {
  const dates = value.match(/\b\d{4}-\d{2}-\d{2}(?:T\S+)?\b/g) ?? [];
  const relative = value.match(
    /\b(today|now|current(?:\s+status)?|latest|recent(?:ly|\s+changes?)?|newest|this\s+week|up[ -]to[ -]date|yesterday|tomorrow|last\s+\d+\s+(?:days?|weeks?|months?)|as of)\b/i,
  )?.[0];
  if (dates.length === 0 && !relative) return undefined;
  return {
    expression: dedupeStrings([...dates, ...(relative ? [relative] : [])]).join(' '),
    ...(dates[0] === undefined ? {} : { start: dates[0] }),
    ...(dates[1] === undefined ? {} : { end: dates[1] }),
    requiresCurrentData: Boolean(
      relative &&
      /today|now|current|latest|recent|newest|this\s+week|up[ -]to[ -]date/i.test(relative),
    ),
  };
}

function detectOperation(value: string): NormalizedIntent['operation'] {
  if (/\b(delete|remove|erase)\b/i.test(value)) return 'delete';
  if (/\b(update|change|edit|modify|set)\b/i.test(value)) return 'update';
  if (/\b(create|build|generate|write|add)\b/i.test(value)) return 'create';
  if (/\b(run|execute|invoke|deploy|send)\b/i.test(value)) return 'execute';
  if (/\b(analy[sz]e|compare|evaluate|diagnose|investigate|review)\b/i.test(value))
    return 'analyze';
  if (/\b(answer|explain|show|find|list|what|who|when|where|why|how)\b/i.test(value))
    return 'answer';
  return 'unknown';
}

function firstGoalClause(value: string): string {
  return splitClauses(value)[0] ?? value;
}

function extractRequestedOutput(value: string): string | undefined {
  return value
    .match(
      /\b(?:as|in|return|output)\s+(?:a\s+)?(json|csv|table|list|report|summary|markdown|document|spreadsheet)\b/i,
    )?.[1]
    ?.toLowerCase();
}

function expectedEvidence(intent: NormalizedIntent): string[] {
  return dedupeStrings([
    ...intent.entities.map((entity) => entity.value),
    ...(intent.temporal?.requiresCurrentData ? ['current authoritative state'] : []),
    ...intent.constraints,
  ]);
}

function preservesLockedValues(value: string, intent: NormalizedIntent): boolean {
  const normalized = value.toLowerCase();
  return intent.entities.every((entity) => normalized.includes(entity.value.toLowerCase()));
}
