import type { Tool } from '../tool.js';
import { createTavilySearchProvider, type WebSearchProvider } from './search-provider.js';
import { createWebFetchTool, type WebFetchToolOptions } from './web-fetch-tool.js';
import { createWebSearchTool, type WebSearchToolOptions } from './web-search-tool.js';

export type WebToolsOptions = {
  /** Set to `false` to omit `web_fetch`. */
  fetch?: WebFetchToolOptions | false;
  /**
   * Search backend. Defaults to Tavily when `TAVILY_API_KEY` is set; when no
   * provider is available `web_search` is simply not registered.
   */
  searchProvider?: WebSearchProvider;
  search?: Omit<WebSearchToolOptions, 'provider'>;
};

/**
 * Build the opt-in network tool set. Kept separate from `createBuiltinTools`
 * so existing workspace-only sessions keep exactly the tools they had.
 *
 * Both tools report `kind: 'network'`, so the default and rule permission
 * handlers ask before running them.
 */
export function createWebTools(options: WebToolsOptions = {}): Tool[] {
  const tools: Tool[] = [];
  if (options.fetch !== false) tools.push(createWebFetchTool(options.fetch ?? {}));
  const provider = options.searchProvider ?? tavilyProviderFromEnvironment();
  if (provider) tools.push(createWebSearchTool({ provider, ...options.search }));
  return tools;
}

/** Tavily provider from `TAVILY_API_KEY`, or `undefined` when unset. */
export function tavilyProviderFromEnvironment(): WebSearchProvider | undefined {
  if (!process.env.TAVILY_API_KEY?.trim()) return undefined;
  return createTavilySearchProvider();
}

export {
  createTavilySearchProvider,
  TAVILY_SEARCH_ENDPOINT,
  type TavilySearchProviderOptions,
  type WebSearchHit,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResponse,
} from './search-provider.js';
export {
  createWebFetchTool,
  type WebFetchInput,
  type WebFetchSummarizer,
  type WebFetchToolOptions,
} from './web-fetch-tool.js';
export {
  createWebSearchTool,
  type WebSearchInput,
  type WebSearchToolOptions,
} from './web-search-tool.js';
export {
  assertHostAllowed,
  isNonPublicHost,
  isSameSiteRedirect,
  MAX_FETCH_URL_LENGTH,
  resolveFetchUrl,
  type UrlPolicyOptions,
} from './url-policy.js';
export { decodeHtmlEntities, extractHtmlTitle, htmlToReadableText } from './html-text.js';
