# Web Research Agent Demo

This demo stores a complete Web Research Agent definition in MongoDB and runs
it through the frontend-independent platform HTTP/SSE API. The definition uses
OpenRouter for model inference and the trusted `web_search@1` tool for Tavily
search.

## Security boundary

MongoDB stores the model and tool secret references, never their values:

- `OPENROUTER_API_KEY`
- `TAVILY_API_KEY`

For tenant `tenant-a`, the default secret resolver reads these values from:

- `PLATFORM_SECRET_TENANT_A__OPENROUTER_API_KEY`
- `PLATFORM_SECRET_TENANT_A__TAVILY_API_KEY`

`web_search@1` always calls the trusted Tavily endpoint. A database definition
cannot override the endpoint and redirect a tenant credential.
The stored `maxResults` value is a hard per-request ceiling, and
`maxSearchesPerSession` bounds Tavily usage even when a model emits parallel
search calls.

## Start and configure

```bash
MONGODB_URI='mongodb+srv://...' \
PLATFORM_BOOTSTRAP_API_KEY='replace-with-a-random-platform-key' \
PLATFORM_BOOTSTRAP_TENANT='tenant-a' \
PLATFORM_SECRET_TENANT_A__OPENROUTER_API_KEY='...' \
PLATFORM_SECRET_TENANT_A__TAVILY_API_KEY='...' \
npm run platform
```

In another terminal, use the bootstrap key to create or version and deploy the
stable `web-research-agent` slug:

```bash
PLATFORM_API_KEY='replace-with-a-random-platform-key' \
npm run platform:setup:web-search
```

Run the acceptance question:

```bash
PLATFORM_API_KEY='replace-with-a-random-platform-key' \
PLATFORM_AGENT='web-research-agent' \
npm run platform:run -- \
  'Explain the principles of modern AI agent system design.'
```

The run client streams assistant text, automatically handles permission events,
and prints the durable session and run IDs for API replay and inspection.

See the [live acceptance result](./web-search-agent-live-result.md) for the
captured Atlas/OpenRouter/Tavily execution evidence and free-model routing
observations.

## Expected trajectory

1. The API resolves the production deployment and immutable agent version.
2. The model requests `web_search` with one or more focused queries.
3. The tool resolves the tenant Tavily secret and returns bounded source data.
4. The model produces a detailed answer with Markdown links to returned URLs.
5. MongoDB retains the messages, tool results, run state, events, and audit
   history.
