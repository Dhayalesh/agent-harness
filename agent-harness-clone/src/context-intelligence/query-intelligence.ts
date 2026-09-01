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

export type RetrievalRequestCandidate = {
  query: string;
  informationNeed: string;
  construction:
    'normalized_intent' | 'query_variant' | 'decomposed_information_need' | 'semantic_compaction';
  semanticallyCompacted: boolean;
};

export class IntentResolver {
  resolve(rawRequest: string): NormalizedIntent {
    const originalRequest = rawRequest.trim();
    const segmented = segmentRequest(originalRequest);
    const informationText = segmented.informationRequirements.join(' ').trim();
    const normalizedRequest = withRetrievalModifiers(
      normalizeQuery(informationText || segmented.userIntent),
      retrievalModifiers([informationText]),
    );
    const instructionSegments = { ...segmented, userIntent: normalizedRequest };
    const entities = extractEntities(normalizedRequest);
    const constraints = extractConstraints(
      [...instructionSegments.taskInstructions, originalRequest].join('\n'),
    );
    const temporal = extractTemporal(normalizedRequest);
    const clauses = instructionSegments.informationRequirements.flatMap(
      decomposeInformationRequirement,
    );
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
    return [intent.normalizedRequest];
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
      .flatMap(decomposeInformationRequirement)
      .filter((entry) => uniqueTerms(entry).length >= 2);
  }
}

/**
 * Constructs tool-ready semantic retrieval requests without treating the raw
 * request as a capability argument. A long need is decomposed first; semantic
 * keyword compaction is the final fallback and preserves known entities,
 * freshness/authority requirements, quoted phrases, and negations.
 */
export function buildRetrievalRequestCandidates(input: {
  intent: NormalizedIntent;
  plan?: QueryPlan;
  requested?: string;
  maximumLength?: number;
  maximumCandidates?: number;
  preferDecomposition?: boolean;
}): RetrievalRequestCandidate[] {
  const maximumLength =
    input.maximumLength !== undefined && Number.isFinite(input.maximumLength)
      ? Math.max(1, Math.floor(input.maximumLength))
      : undefined;
  const maximumCandidates = Math.max(1, Math.floor(input.maximumCandidates ?? 8));
  const requested = normalizeQuery(input.requested ?? input.intent.normalizedRequest);
  const modifiers = retrievalModifiers([
    input.intent.normalizedRequest,
    ...input.intent.instructionSegments.retrievalInstructions,
  ]);
  const requirements = dedupeStrings(
    input.intent.instructionSegments.informationRequirements
      .flatMap((requirement) =>
        input.preferDecomposition ? decomposeInformationRequirement(requirement) : [requirement],
      )
      .map((requirement) => withRetrievalModifiers(requirement, modifiers)),
  );
  const decomposed = dedupeStrings(
    input.intent.instructionSegments.informationRequirements
      .flatMap(decomposeInformationRequirement)
      .map((requirement) => withRetrievalModifiers(requirement, modifiers)),
  );
  const variants = dedupeStrings(
    (input.plan?.variants ?? [])
      .filter((variant) => variant.kind !== 'original')
      .map((variant) => withRetrievalModifiers(variant.query, modifiers)),
  );
  const ordered: Array<{
    value: string;
    construction: RetrievalRequestCandidate['construction'];
    informationNeed: string;
  }> = [];
  const add = (
    values: readonly string[],
    construction: RetrievalRequestCandidate['construction'],
  ) => {
    for (const value of values) {
      ordered.push({ value, construction, informationNeed: value });
    }
  };

  if (input.preferDecomposition) {
    add(decomposed, 'decomposed_information_need');
    add(variants, 'query_variant');
    add(requirements, 'decomposed_information_need');
    add([requested], 'normalized_intent');
  } else {
    // The requested value is the authoritative retrieval request. Capability-specific
    // compaction must start from it rather than replacing it with a parallel intent
    // representation merely because the original value exceeds a tool limit.
    add([requested], 'normalized_intent');
    add(variants, 'query_variant');
    add(requirements, 'decomposed_information_need');
  }

  const output: RetrievalRequestCandidate[] = [];
  for (const candidate of ordered) {
    const fitted = fitSemanticQuery(candidate.value, maximumLength, input.intent, modifiers);
    if (!fitted || output.some((entry) => normalizeQuery(entry.query) === fitted.query)) continue;
    output.push({
      query: fitted.query,
      informationNeed: candidate.informationNeed,
      construction: fitted.compacted ? 'semantic_compaction' : candidate.construction,
      semanticallyCompacted: fitted.compacted,
    });
    if (output.length >= maximumCandidates) break;
  }
  return output;
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
  const diagnosticEnvelope = clauses.some(isDiagnosticEnvelopeSignal);
  let formattingFieldSection = false;
  let awaitingInformationRequirement = false;
  let diagnosticInformationRequirementCaptured = false;

  for (const clause of clauses) {
    if (isFormattingFieldSectionStart(clause)) {
      formattingInstructions.push(clause);
      formattingFieldSection = true;
      continue;
    }
    if (formattingFieldSection) {
      if (isFormattingFieldDescriptor(clause)) {
        formattingInstructions.push(clause);
        continue;
      }
      formattingFieldSection = false;
    }
    if (isSystemToolInstruction(clause) || isValidationInstruction(clause)) {
      systemToolInstructions.push(clause);
      continue;
    }
    if (isFormattingInstruction(clause)) {
      formattingInstructions.push(clause);
      const subject = informationBeforeDirective(clause, OUTPUT_DIRECTIVE);
      const accepted =
        subject &&
        acceptsDiagnosticInformationRequirement({
          diagnosticEnvelope,
          awaitingInformationRequirement,
          diagnosticInformationRequirementCaptured,
          candidate: subject,
          explicitInformationRequirement: isExplicitInformationRequirement(clause),
        });
      if (subject && accepted) {
        informationRequirements.push(subject);
        if (diagnosticEnvelope) diagnosticInformationRequirementCaptured = true;
      } else if (subject && diagnosticEnvelope) {
        systemToolInstructions.push(clause);
      }
      continue;
    }
    if (isRetrievalInstruction(clause)) {
      const subject = informationBeforeDirective(clause, RETRIEVAL_DIRECTIVE);
      const accepted =
        subject &&
        acceptsDiagnosticInformationRequirement({
          diagnosticEnvelope,
          awaitingInformationRequirement,
          diagnosticInformationRequirementCaptured,
          candidate: subject,
          explicitInformationRequirement: isExplicitInformationRequirement(clause),
        });
      if (subject && accepted) {
        informationRequirements.push(subject);
        if (diagnosticEnvelope) diagnosticInformationRequirementCaptured = true;
      } else if (subject && diagnosticEnvelope) {
        systemToolInstructions.push(clause);
        continue;
      }
      retrievalInstructions.push(clause);
      if (introducesInformationRequirement(clause)) awaitingInformationRequirement = true;
      continue;
    }
    if (isTaskInstruction(clause)) {
      taskInstructions.push(clause);
      continue;
    }

    const explicitInformationRequirement = isExplicitInformationRequirement(clause);
    const acceptsInformationRequirement = acceptsDiagnosticInformationRequirement({
      diagnosticEnvelope,
      awaitingInformationRequirement,
      diagnosticInformationRequirementCaptured,
      candidate: clause,
      explicitInformationRequirement,
    });
    const subject =
      diagnosticEnvelope && acceptsInformationRequirement
        ? normalizeExplicitInformationRequirement(clause)
        : cleanInformationRequirement(clause);
    if (subject && acceptsInformationRequirement) {
      informationRequirements.push(subject);
      if (diagnosticEnvelope) diagnosticInformationRequirementCaptured = true;
    } else if (subject && diagnosticEnvelope) {
      systemToolInstructions.push(clause);
    }
    if (awaitingInformationRequirement || explicitInformationRequirement) {
      awaitingInformationRequirement = false;
    }
  }

  const requirements = dedupeStrings(informationRequirements)
    .filter((entry) => entry.length >= 2)
    .slice(0, 12);
  const userIntent = normalizeQuery(requirements.join('; '));
  return {
    userIntent,
    taskInstructions: dedupeStrings(taskInstructions).slice(0, 50),
    retrievalInstructions: dedupeStrings(retrievalInstructions).slice(0, 30),
    systemToolInstructions: dedupeStrings(systemToolInstructions).slice(0, 30),
    formattingInstructions: dedupeStrings(formattingInstructions).slice(0, 30),
    informationRequirements: requirements.map(normalizeQuery),
  };
}

function acceptsDiagnosticInformationRequirement(input: {
  diagnosticEnvelope: boolean;
  awaitingInformationRequirement: boolean;
  diagnosticInformationRequirementCaptured: boolean;
  candidate: string;
  explicitInformationRequirement: boolean;
}): boolean {
  if (!input.diagnosticEnvelope) return true;
  if (input.awaitingInformationRequirement) return true;
  if (!input.explicitInformationRequirement) return false;
  if (!input.diagnosticInformationRequirementCaptured) return true;
  return isInterrogativeInformationRequirement(input.candidate);
}

function isInterrogativeInformationRequirement(value: string): boolean {
  const requirement = normalizeExplicitInformationRequirement(value);
  return /^(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b[\s\S]*\?$/i.test(
    requirement,
  );
}

function isDiagnosticEnvelopeSignal(value: string): boolean {
  return (
    /\b(?:runtime|retrieval|harness|capability|tool(?:[ -]input)?)\s+(?:test|diagnostic|validation)\b/i.test(
      value,
    ) ||
    /\b(?:test|validation)\s+(?:prompt|request|instructions?|assertions?|criteria)\b/i.test(
      value,
    ) ||
    /\b(?:test|validation)\s+(?:passes|fails)\s+(?:only\s+)?if\b/i.test(value)
  );
}

function introducesInformationRequirement(value: string): boolean {
  return (
    /\b(?:answer|address)\s*:\s*$/i.test(value) ||
    /^(?:question|research question|information need|topic)\s*:\s*$/i.test(value)
  );
}

function isExplicitInformationRequirement(value: string): boolean {
  const requirement = normalizeExplicitInformationRequirement(value);
  if (!requirement || isControlPlaneAssertion(requirement)) return false;
  return (
    /^(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b[\s\S]*\?$/i.test(
      requirement,
    ) ||
    /^(?:find|compare|contrast|explain|describe|summarize|list|identify|determine|research|investigate|analy[sz]e|review|retrieve|locate)\b/i.test(
      requirement,
    )
  );
}

function isControlPlaneAssertion(value: string): boolean {
  return /\b(?:runtime (?:test|diagnostic|validation)|validation test|test (?:passes|fails|assertion|instruction)|actual (?:tool call|tool input|input)|normalized retrieval request|raw (?:prompt|request)|orchestration instruction|selected capability|context need|grounding decision|answer quality)\b/i.test(
    value,
  );
}

function normalizeExplicitInformationRequirement(value: string): string {
  const labelled = normalizeQuery(value).replace(
    /^(?:question|research question|information need|topic)\s*:\s*/i,
    '',
  );
  const wrapped = labelled.match(/^["'“‘]([\s\S]*)["'”’]$/);
  return normalizeQuery(wrapped?.[1] ?? labelled);
}

const OUTPUT_DIRECTIVE =
  /\s+(?:and\s+)?(?:return|respond|format|present|output|render|write)\b[\s\S]*$/i;
const RETRIEVAL_DIRECTIVE =
  /\s+(?:using|via|with)\s+(?:the\s+)?(?:available\s+)?(?:web|internet|browser|search|tools?|capabilit(?:y|ies)|mcp)\b[\s\S]*$/i;

function informationBeforeDirective(value: string, directive: RegExp): string {
  const match = directive.exec(value);
  if (!match || match.index === 0) return '';
  const subject = cleanInformationRequirement(value.slice(0, match.index));
  return isAnaphoricRetrievalWrapper(subject) ? '' : subject;
}

function cleanInformationRequirement(value: string): string {
  return normalizeQuery(
    value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*(?:question|research question|information need|topic)\s*:\s*/i, '')
      .replace(
        /^\s*(?:please\s+)?(?:find|search(?:\s+for)?|look\s+up|browse(?:\s+for)?|retrieve|fetch|tell\s+me|show\s+me|give\s+me|research|investigate)\b\s*/i,
        '',
      )
      .replace(OUTPUT_DIRECTIVE, ' ')
      .replace(RETRIEVAL_DIRECTIVE, ' ')
      .replace(/\b(?:cite|include)\s+(?:the\s+)?sources?\b/gi, ' ')
      .replace(/\s+/g, ' '),
  );
}

function isSystemToolInstruction(value: string): boolean {
  return (
    /\b(system prompt|developer instructions?|tool instructions?|available tools?|tool registry|permission mode|authorization policy|test harness|execution prompt|ignore previous|chain[- ]of[- ]thought|runtime diagnostic|purpose of (?:this|the) test)\b/i.test(
      value,
    ) ||
    /^(?:context entry|environment context|instructions?|rules?|non-negotiable|acceptance criteria)\s*:?$/i.test(
      value,
    ) ||
    /^(?:scenario|test case|expected|actual|incorrect|correct|failure|invariant|validation|example)\s*\d*\s*:/i.test(
      value,
    ) ||
    /^(?:expected|actual|never|must not)\s*(?:→|->|:)/i.test(value)
  );
}

function isFormattingFieldSectionStart(value: string): boolean {
  return /^(?:(?:at\s+the\s+end|finally)\s*,?\s*)?(?:report|output|return|respond|present)(?:\s+(?:the\s+)?following)?\s*:?$/i.test(
    value,
  );
}

function isFormattingFieldDescriptor(value: string): boolean {
  const descriptor = value.replace(/[:：]\s*$/, '').trim();
  return (
    descriptor.length > 0 &&
    descriptor.length <= 100 &&
    descriptor.split(/\s+/).length <= 12 &&
    !/[.!?]/.test(descriptor) &&
    !/^(?:what|which|who|when|where|why|how|find|research|investigate|explain|describe|compare)\b/i.test(
      descriptor,
    )
  );
}

function isFormattingInstruction(value: string): boolean {
  return /\b(?:return|respond|format|present|output|render|write)\b.{0,80}\b(?:json|csv|table|list|report|summary|markdown|document|xml|yaml|bullet|code block)\b/i.test(
    value,
  );
}

function isRetrievalInstruction(value: string): boolean {
  return (
    /\b(?:search|browse|look\s+up|retrieve|fetch|verify|cite|source|use|using|via)\b.{0,120}\b(?:web|internet|online|official|authoritative|source|documentation|database|api|mcp|tools?|capabilit(?:y|ies))\b/i.test(
      value,
    ) ||
    /^(?:research|answer|investigate)\s+(?:this|the)\s+(?:question|topic|request)\b.{0,120}\b(?:web|internet|online|source|information)\b/i.test(
      value,
    )
  );
}

function isValidationInstruction(value: string): boolean {
  return (
    /^(?:if|when)\s+(?:the\s+)?(?:first|prior|previous|next)?\s*(?:retrieval|attempt|result)\b/i.test(
      value,
    ) ||
    /\b(?:prove|demonstrate|validate|report|show)\b.{0,100}\b(?:adaptive retrieval|attempt\s*\d+|runtime telemetry|grounding gate|execution state|retrieval state)\b/i.test(
      value,
    ) ||
    /^(?:evaluate|classify|adapt|retry|retrieve again|change strategy)\b.{0,160}\b(?:retrieval|result|evidence|strategy|telemetry|attempt)\b/i.test(
      value,
    ) ||
    /^(?:pass\s*\/\s*fail|runtime telemetry|execution state|retrieval state)\s*[.:]?$/i.test(value)
  );
}

function isAnaphoricRetrievalWrapper(value: string): boolean {
  return /^(?:research|answer|investigate)?\s*(?:this|the)\s+(?:question|topic|request)$/i.test(
    normalizeQuery(value).replace(/[:.?]+$/, ''),
  );
}

function isTaskInstruction(value: string): boolean {
  return (
    /^(?:must|never|only|ensure|do not|don't|without|before|after|limit|maximum|minimum)\b/i.test(
      value,
    ) ||
    /^(?:then\s+)?(?:execute|run|invoke|call)\b.{0,160}\b(?:retrieval|search|fetch|tool|capabilit(?:y|ies))\b/i.test(
      value,
    ) ||
    /\b(?:do not run tests|no test execution|do not clone|preserve backward compatibility)\b/i.test(
      value,
    )
  );
}

function normalizeQuery(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function retrievalModifiers(values: readonly string[]): string[] {
  const text = values.join(' ');
  return dedupeStrings([
    ...(text.match(
      /\b(?:today|current|currently|latest|recent|newest|up[ -]to[ -]date|as of\s+\d{4}(?:-\d{2}-\d{2})?)\b/gi,
    ) ?? []),
    ...(text.match(
      /\b(?:official|authoritative|primary source|first-party|trusted|verified)\b/gi,
    ) ?? []),
    ...(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []),
  ]).map(normalizeQuery);
}

function withRetrievalModifiers(value: string, modifiers: readonly string[]): string {
  const normalized = normalizeQuery(value);
  const lower = normalized.toLowerCase();
  const missing = modifiers.filter((modifier) => !lower.includes(modifier.toLowerCase()));
  return normalizeQuery([normalized, ...missing].filter(Boolean).join(' '));
}

function fitSemanticQuery(
  value: string,
  maximumLength: number | undefined,
  intent: NormalizedIntent,
  modifiers: readonly string[],
): { query: string; compacted: boolean } | undefined {
  const normalized = normalizeQuery(value);
  if (!normalized) return undefined;
  if (maximumLength === undefined || normalized.length <= maximumLength) {
    return { query: normalized, compacted: false };
  }

  const protectedPhrases = dedupeStrings([
    ...intent.entities
      .map((entity) => entity.value)
      .filter((entity) => normalized.toLowerCase().includes(entity.toLowerCase())),
    ...(normalized.match(/"[^"]+"|'[^']+'/g) ?? []).map((phrase) =>
      phrase.replace(/^['"]|['"]$/g, ''),
    ),
    ...modifiers,
    ...(normalized.match(
      /\b(?:not|without|exclude|excluding|except)\b(?:\s+[\p{L}\p{N}_.:/\\-]+){0,6}/giu,
    ) ?? []),
  ]).map(normalizeQuery);
  let compact = '';
  for (const phrase of protectedPhrases) {
    const next = appendUniqueSemanticPart(compact, phrase);
    if (next.length > maximumLength) return undefined;
    compact = next;
  }
  for (const term of uniqueTerms(normalized)) {
    const next = appendUniqueSemanticPart(compact, term);
    if (next.length <= maximumLength) compact = next;
  }
  compact = normalizeQuery(compact);
  return compact ? { query: compact, compacted: true } : undefined;
}

function appendUniqueSemanticPart(current: string, part: string): string {
  const normalizedPart = normalizeQuery(part);
  if (!normalizedPart) return current;
  const currentTerms = new Set(uniqueTerms(current));
  const newTerms = uniqueTerms(normalizedPart);
  if (newTerms.length > 0 && newTerms.every((term) => currentTerms.has(term))) return current;
  return normalizeQuery(`${current} ${normalizedPart}`);
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

function decomposeInformationRequirement(value: string): string[] {
  const ordinary = splitClauses(value);
  if (ordinary.length > 1) return ordinary;
  const comparisonBody = normalizeQuery(value)
    .replace(/^\s*(?:research|compare|contrast|evaluate|analy[sz]e)\s+/i, '')
    .replace(/\s+and\s+(?:compare|contrast|evaluate|analy[sz]e)(?:\s+them)?[.!?]*$/i, '');
  const parts = comparisonBody
    .split(/\s*,\s*/)
    .map((part) => normalizeQuery(part.replace(/^(?:and|versus|vs\.?)\s+/i, '')))
    .filter((part) => uniqueTerms(part).length > 0);
  return parts.length >= 3 ? dedupeStrings(parts) : ordinary;
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
    ...retrievalModifiers(intent.instructionSegments.retrievalInstructions),
  ]);
}

function preservesLockedValues(value: string, intent: NormalizedIntent): boolean {
  const normalized = value.toLowerCase();
  return intent.entities.every((entity) => normalized.includes(entity.value.toLowerCase()));
}
