import type { ContextIntelligenceConfig } from './config.js';
import type { Provenance, SourceMetadata } from './contracts.js';
import {
  appendProvenance,
  estimateTokens,
  id,
  lexicalSimilarity,
  provenance,
  stableHash,
} from './utils.js';

export type DocumentDescriptor = {
  id: string;
  content: string;
  contentType: string;
  title?: string;
  source: SourceMetadata;
  metadata: Readonly<Record<string, unknown>>;
  structure?: 'flat' | 'sections' | 'hierarchical' | 'tabular' | 'code' | 'unknown';
};

export type DocumentChunk = {
  id: string;
  documentId: string;
  parentId?: string;
  children: readonly string[];
  index: number;
  level: number;
  content: string;
  headingPath: readonly string[];
  tokenEstimate: number;
  startOffset: number;
  endOffset: number;
  source: SourceMetadata;
  provenance: Provenance;
  metadata: Readonly<Record<string, unknown>>;
};

export type ChunkingContext = {
  targetTokens: number;
  overlapTokens: number;
  maximumTokens: number;
  query?: string;
  signal: AbortSignal;
};

export interface ChunkingStrategy {
  readonly name: ContextIntelligenceConfig['chunking']['defaultStrategy'];
  supports(document: DocumentDescriptor): boolean;
  chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]>;
}

export interface ChunkBoundaryProvider {
  boundaries(
    document: DocumentDescriptor,
    context: ChunkingContext,
  ): Promise<readonly { start: number; end: number; title?: string }[]>;
}

export interface AgenticChunkReviewer {
  review(
    document: DocumentDescriptor,
    chunks: readonly DocumentChunk[],
    context: ChunkingContext,
  ): Promise<readonly { operation: 'keep' | 'merge-next' | 'split'; chunkId: string; offsets?: readonly number[] }[]>;
}

abstract class BaseChunkingStrategy implements ChunkingStrategy {
  abstract readonly name: ChunkingStrategy['name'];

  supports(_document: DocumentDescriptor): boolean {
    return true;
  }

  abstract chunk(
    document: DocumentDescriptor,
    context: ChunkingContext,
  ): Promise<readonly DocumentChunk[]>;

  protected create(
    document: DocumentDescriptor,
    content: string,
    index: number,
    startOffset: number,
    headingPath: readonly string[] = [],
    level = 0,
    parentId?: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ): DocumentChunk {
    const sourceProvenance = provenance(document.source, 'received', `chunking.${this.name}`, [document.id]);
    return {
      id: id('chunk'),
      documentId: document.id,
      ...(parentId === undefined ? {} : { parentId }),
      children: [],
      index,
      level,
      content,
      headingPath: [...headingPath],
      tokenEstimate: estimateTokens(content),
      startOffset,
      endOffset: startOffset + content.length,
      source: document.source,
      provenance: appendProvenance(sourceProvenance, 'shaped', `chunking.${this.name}`, [document.id], {
        strategy: this.name,
        index,
      }),
      metadata: { ...metadata, contentHash: stableHash(content), strategy: this.name },
    };
  }
}

export class FixedSizeChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'fixed' as const;

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const targetChars = Math.max(100, context.targetTokens * 4);
    const overlapChars = Math.min(targetChars - 1, Math.max(0, context.overlapTokens * 4));
    const chunks: DocumentChunk[] = [];
    for (let start = 0; start < document.content.length; start += targetChars - overlapChars) {
      if (context.signal.aborted) break;
      const content = document.content.slice(start, start + targetChars);
      chunks.push(this.create(document, content, chunks.length, start));
      if (start + targetChars >= document.content.length) break;
    }
    return chunks;
  }
}

export class RecursiveChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'recursive' as const;
  private readonly separators = ['\n\n', '\n', '. ', '; ', ', ', ' '];

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const target = context.targetTokens * 4;
    const pieces = recursivelySplit(document.content, target, this.separators);
    return withOverlap(pieces, context.overlapTokens * 4).map(({ content, start }, index) =>
      this.create(document, content, index, start),
    );
  }
}

export class DocumentStructureChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'document' as const;

  override supports(document: DocumentDescriptor): boolean {
    return document.structure !== 'flat' || /^(#|<h[1-6]|\s*[-*]\s|```)/im.test(document.content);
  }

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const sections = parseSections(document.content);
    const output: DocumentChunk[] = [];
    for (const section of sections) {
      const pieces = recursivelySplit(section.content, context.maximumTokens * 4, ['\n\n', '\n', '. ', ' ']);
      for (const piece of pieces) {
        const start = section.start + section.content.indexOf(piece);
        output.push(this.create(document, piece, output.length, start, section.headings));
      }
    }
    return output;
  }
}

export class SemanticChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'semantic' as const;

  constructor(private readonly threshold = 0.42) {
    super();
  }

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const paragraphs = locateParagraphs(document.content);
    const groups: typeof paragraphs[] = [];
    let current: typeof paragraphs = [];
    for (const paragraph of paragraphs) {
      const previous = current[current.length - 1];
      const projectedTokens = estimateTokens(current.map((entry) => entry.content).join('\n\n') + paragraph.content);
      if (
        current.length > 0 &&
        (projectedTokens > context.maximumTokens ||
          (previous && lexicalSimilarity(previous.content, paragraph.content) < this.threshold))
      ) {
        groups.push(current);
        current = [];
      }
      current.push(paragraph);
    }
    if (current.length > 0) groups.push(current);
    return groups.map((group, index) => {
      const first = group[0]!;
      return this.create(document, group.map((entry) => entry.content).join('\n\n'), index, first.start);
    });
  }
}

export class LlmChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'llm' as const;

  constructor(private readonly boundaryProvider: ChunkBoundaryProvider) {
    super();
  }

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const boundaries = await this.boundaryProvider.boundaries(document, context);
    const valid = validateBoundaries(boundaries, document.content.length);
    return valid.map((boundary, index) =>
      this.create(
        document,
        document.content.slice(boundary.start, boundary.end),
        index,
        boundary.start,
        boundary.title ? [boundary.title] : [],
      ),
    );
  }
}

export class AgenticChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'agentic' as const;

  constructor(
    private readonly reviewer: AgenticChunkReviewer,
    private readonly base: ChunkingStrategy = new RecursiveChunkingStrategy(),
  ) {
    super();
  }

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const initial = [...(await this.base.chunk(document, context))];
    const review = await this.reviewer.review(document, initial, context);
    const operations = new Map(review.map((entry) => [entry.chunkId, entry]));
    const output: DocumentChunk[] = [];
    for (let index = 0; index < initial.length; index += 1) {
      const chunk = initial[index]!;
      const operation = operations.get(chunk.id);
      if (operation?.operation === 'merge-next' && initial[index + 1]) {
        const next = initial[index + 1]!;
        output.push(this.create(document, `${chunk.content}\n\n${next.content}`, output.length, chunk.startOffset));
        index += 1;
        continue;
      }
      if (operation?.operation === 'split' && operation.offsets?.length) {
        const offsets = [0, ...operation.offsets, chunk.content.length]
          .filter((offset) => offset >= 0 && offset <= chunk.content.length)
          .sort((left, right) => left - right);
        for (let part = 0; part < offsets.length - 1; part += 1) {
          const start = offsets[part]!;
          const end = offsets[part + 1]!;
          if (end > start) output.push(this.create(document, chunk.content.slice(start, end), output.length, chunk.startOffset + start));
        }
        continue;
      }
      output.push({ ...chunk, index: output.length, metadata: { ...chunk.metadata, strategy: this.name } });
    }
    return output;
  }
}

export class HierarchicalChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'hierarchical' as const;

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const sections = parseSections(document.content);
    const output: DocumentChunk[] = [];
    for (const section of sections) {
      const parent = this.create(document, section.content, output.length, section.start, section.headings, 0);
      const children = recursivelySplit(section.content, context.targetTokens * 4, ['\n\n', '\n', '. ', ' ']).map(
        (content, index) =>
          this.create(
            document,
            content,
            index,
            section.start + section.content.indexOf(content),
            section.headings,
            1,
            parent.id,
          ),
      );
      output.push({ ...parent, children: children.map((child) => child.id) }, ...children);
    }
    return output.map((chunk, index) => ({ ...chunk, index }));
  }
}

export class LateChunkingStrategy extends BaseChunkingStrategy {
  readonly name = 'late' as const;

  constructor(private readonly base: ChunkingStrategy = new SemanticChunkingStrategy()) {
    super();
  }

  async chunk(document: DocumentDescriptor, context: ChunkingContext): Promise<readonly DocumentChunk[]> {
    const chunks = await this.base.chunk(document, context);
    const documentHash = stableHash(document.content);
    const synopsis = document.content.slice(0, Math.min(2_000, document.content.length));
    return chunks.map((chunk) => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        strategy: this.name,
        lateContext: { documentHash, title: document.title, synopsis },
      },
    }));
  }
}

export class ChunkingStrategyRegistry {
  private readonly strategies = new Map<ChunkingStrategy['name'], ChunkingStrategy>();

  constructor(strategies: readonly ChunkingStrategy[] = []) {
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy: ChunkingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: ChunkingStrategy['name']): ChunkingStrategy | undefined {
    return this.strategies.get(name);
  }

  list(): readonly ChunkingStrategy[] {
    return [...this.strategies.values()];
  }
}

export class ChunkingIntelligence {
  readonly registry: ChunkingStrategyRegistry;

  constructor(
    private readonly config: ContextIntelligenceConfig['chunking'],
    extraStrategies: readonly ChunkingStrategy[] = [],
  ) {
    this.registry = new ChunkingStrategyRegistry([
      new FixedSizeChunkingStrategy(),
      new RecursiveChunkingStrategy(),
      new DocumentStructureChunkingStrategy(),
      new SemanticChunkingStrategy(config.semanticThreshold),
      new HierarchicalChunkingStrategy(),
      new LateChunkingStrategy(),
      ...extraStrategies,
    ]);
  }

  select(document: DocumentDescriptor, phase: 'pre' | 'post', query?: string): ChunkingStrategy {
    if (phase === 'post' && query && this.registry.get('semantic')) return this.registry.get('semantic')!;
    if (document.structure === 'hierarchical' && this.registry.get('hierarchical')) return this.registry.get('hierarchical')!;
    if (document.structure === 'sections' && this.registry.get('document')) return this.registry.get('document')!;
    if (document.content.length > this.config.maximumTokens * 20 && this.registry.get('recursive')) {
      return this.registry.get('recursive')!;
    }
    return this.registry.get(this.config.defaultStrategy) ?? this.registry.get('recursive')!;
  }

  async chunk(
    document: DocumentDescriptor,
    options: { phase?: 'pre' | 'post'; query?: string; signal?: AbortSignal; strategy?: ChunkingStrategy['name'] } = {},
  ): Promise<readonly DocumentChunk[]> {
    const requested = options.strategy ? this.registry.get(options.strategy) : undefined;
    const selected = requested ?? this.select(document, options.phase ?? 'pre', options.query);
    if (!selected.supports(document)) {
      return this.registry.get('recursive')!.chunk(document, chunkingContext(this.config, options));
    }
    return selected.chunk(document, chunkingContext(this.config, options));
  }
}

function chunkingContext(
  config: ContextIntelligenceConfig['chunking'],
  options: { query?: string; signal?: AbortSignal },
): ChunkingContext {
  return {
    targetTokens: config.targetTokens,
    overlapTokens: config.overlapTokens,
    maximumTokens: config.maximumTokens,
    ...(options.query === undefined ? {} : { query: options.query }),
    signal: options.signal ?? new AbortController().signal,
  };
}

function recursivelySplit(content: string, maximumChars: number, separators: readonly string[]): string[] {
  if (content.length <= maximumChars) return content.trim() ? [content.trim()] : [];
  const separator = separators.find((candidate) => content.includes(candidate));
  if (!separator) {
    const output: string[] = [];
    for (let index = 0; index < content.length; index += maximumChars) output.push(content.slice(index, index + maximumChars));
    return output;
  }
  const pieces = content.split(separator);
  const output: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const joined = current ? `${current}${separator}${piece}` : piece;
    if (joined.length <= maximumChars) {
      current = joined;
      continue;
    }
    if (current.trim()) output.push(current.trim());
    if (piece.length > maximumChars) output.push(...recursivelySplit(piece, maximumChars, separators.slice(separators.indexOf(separator) + 1)));
    else current = piece;
  }
  if (current.trim()) output.push(current.trim());
  return output;
}

function withOverlap(pieces: readonly string[], overlapChars: number): { content: string; start: number }[] {
  let cursor = 0;
  return pieces.map((piece, index) => {
    const prefix = index === 0 ? '' : pieces[index - 1]!.slice(-overlapChars);
    const content = `${prefix}${prefix ? '\n' : ''}${piece}`;
    const start = Math.max(0, cursor - prefix.length);
    cursor += piece.length;
    return { content, start };
  });
}

function parseSections(content: string): { headings: string[]; content: string; start: number }[] {
  const lines = content.split(/(?<=\n)/);
  const sections: { headings: string[]; content: string; start: number }[] = [];
  const headingStack: string[] = [];
  let current = '';
  let start = 0;
  let cursor = 0;
  const flush = (): void => {
    if (current.trim()) sections.push({ headings: [...headingStack], content: current.trim(), start });
    current = '';
  };
  for (const line of lines) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headingStack.splice(level - 1);
      headingStack[level - 1] = heading[2]!;
      start = cursor;
    }
    if (!current) start = cursor;
    current += line;
    cursor += line.length;
  }
  flush();
  return sections.length ? sections : [{ headings: [], content, start: 0 }];
}

function locateParagraphs(content: string): { content: string; start: number }[] {
  const output: { content: string; start: number }[] = [];
  const pattern = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  for (const match of content.matchAll(pattern)) output.push({ content: match[0].trim(), start: match.index });
  return output.length ? output : [{ content, start: 0 }];
}

function validateBoundaries(
  boundaries: readonly { start: number; end: number; title?: string }[],
  length: number,
): { start: number; end: number; title?: string }[] {
  return boundaries
    .filter((entry) => Number.isInteger(entry.start) && Number.isInteger(entry.end) && entry.start >= 0 && entry.end > entry.start && entry.end <= length)
    .sort((left, right) => left.start - right.start)
    .filter((entry, index, all) => index === 0 || entry.start >= all[index - 1]!.end);
}
