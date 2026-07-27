import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

export type WebSearchRequest = {
  query: string;
  maxResults: number;
  signal: AbortSignal;
  topic?: 'general' | 'news';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
};

export type WebSearchHit = {
  title: string;
  url: string;
  excerpt: string;
  score?: number;
  publishedDate?: string;
};

export type WebSearchResponse = {
  hits: readonly WebSearchHit[];
  requestId?: string;
  responseTime?: string | number;
};

/**
 * Search backend contract. Implement this to route `web_search` through any
 * provider; the tool itself owns validation, bounding, and quotas.
 */
export interface WebSearchProvider {
  readonly name: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

export type TavilySearchProviderOptions = {
  /** Falls back to `TAVILY_API_KEY`. */
  apiKey?: string;
  endpoint?: string;
  searchDepth?: 'basic' | 'advanced';
  /** Request full page text per hit instead of a short excerpt. */
  includeRawContent?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const tavilyResponseSchema = z
  .object({
    request_id: z.string().optional(),
    response_time: z.union([z.string(), z.number()]).optional(),
    results: z
      .array(
        z
          .object({
            title: z.string().default(''),
            url: z.string(),
            content: z.string().optional(),
            raw_content: z.string().nullable().optional(),
            score: z.number().optional(),
            published_date: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/** Tavily-backed search provider. */
export function createTavilySearchProvider(
  options: TavilySearchProviderOptions = {},
): WebSearchProvider {
  const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY ?? '';
  if (!apiKey.trim()) {
    throw new AgentHarnessError(
      'Tavily search provider requires an API key: set TAVILY_API_KEY or pass apiKey',
      'MISSING_SEARCH_CREDENTIAL',
    );
  }
  const endpoint = options.endpoint ?? TAVILY_SEARCH_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    name: 'tavily',
    async search(request): Promise<WebSearchResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const abort = (): void => controller.abort(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            query: request.query,
            topic: request.topic ?? 'general',
            search_depth: options.searchDepth ?? 'basic',
            max_results: request.maxResults,
            include_answer: false,
            include_images: false,
            include_raw_content: options.includeRawContent ? 'markdown' : false,
            ...(request.timeRange === undefined ? {} : { time_range: request.timeRange }),
            ...(request.allowedDomains?.length
              ? { include_domains: [...request.allowedDomains] }
              : {}),
            ...(request.blockedDomains?.length
              ? { exclude_domains: [...request.blockedDomains] }
              : {}),
          }),
        });
      } catch (error) {
        if (request.signal.aborted) {
          throw new AgentHarnessError('Web search was cancelled', 'WEB_SEARCH_CANCELLED');
        }
        if (controller.signal.aborted) {
          throw new AgentHarnessError(
            `Web search timed out after ${timeoutMs}ms`,
            'WEB_SEARCH_TIMEOUT',
            true,
          );
        }
        throw new AgentHarnessError(
          `Web search request failed: ${errorMessage(error)}`,
          'WEB_SEARCH_FAILED',
          true,
        );
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
      }
      if (!response.ok) {
        const detail = sanitizeProviderError(await response.text());
        throw Object.assign(
          new AgentHarnessError(
            `Web search provider failed (${response.status})${detail ? `: ${detail}` : ''}`,
            'WEB_SEARCH_PROVIDER_ERROR',
            response.status === 429 || response.status >= 500,
          ),
          { status: response.status },
        );
      }
      const parsed = tavilyResponseSchema.parse(await response.json());
      return {
        hits: parsed.results.flatMap((result) => {
          const url = safeHttpUrl(result.url);
          if (!url) return [];
          return [
            {
              title: result.title,
              url,
              excerpt: result.raw_content ?? result.content ?? '',
              ...(result.score === undefined ? {} : { score: result.score }),
              ...(result.published_date === undefined
                ? {}
                : { publishedDate: result.published_date }),
            },
          ];
        }),
        ...(parsed.request_id === undefined ? {} : { requestId: parsed.request_id }),
        ...(parsed.response_time === undefined ? {} : { responseTime: parsed.response_time }),
      };
    },
  };
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeProviderError(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
