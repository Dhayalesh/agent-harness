# Provider Portability Audit

Read-only audit of `agent-harness-clone` against a target of four interchangeable backends
(`scripted`, `openrouter`, `bedrock` via bedrock-mantle, `on-prem` vLLM/SGLang/Ollama) behind one
provider port, with OpenRouter removable by configuration.

All line citations are against the working tree at audit time.

## Surprises up front

Read these before the detail sections; several contradict the assumptions in the task framing.

1. **The SSE loop is not duplicated.** `OpenRouterModelProvider` does not parse SSE at all. It
   delegates to `OpenAICompatibleModelProvider` (`src/models/openrouter-provider.ts:81`). There is
   exactly one wire implementation in the repo. Section 3's premise ("do they share parsing code,
   or is the SSE logic duplicated") resolves to _fully shared_.
2. **A provider declares no capabilities and no limits.** `ModelProvider` is `name` + `stream`.
   No context window, no max output, no tool-calling flag, no streaming flag. NOT FOUND anywhere.
   Model metadata _is_ available (`OpenRouterModel.contextLength`,
   `src/models/openrouter-provider.ts:33`) but is never fed into the context manager or limits.
3. **An on-prem endpoint with authentication disabled cannot be configured today.** An empty API
   key is a hard constructor error (`src/models/openai-compatible-provider.ts:46`) and the platform
   resolver throws on a missing secret (`src/platform/model-resolver.ts:24`). Air-gapped
   vLLM/Ollama with no auth requires a dummy credential.
4. **The platform header allowlist is OpenRouter-specific and silently drops everything else.**
   `safeModelHeaders` keeps only `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`
   (`src/platform/model-resolver.ts:75`). A Bedrock or on-prem binding cannot pass any custom
   header, and the drop is silent — no error, no warning.
5. **Only `Authorization: Bearer <key>` is supported.** Hardcoded at
   `src/models/openai-compatible-provider.ts:62`. There is no SigV4 signing, no `api-key` header
   form, no credential-provider hook. If bedrock-mantle requires SigV4 for a given deployment
   posture, no configuration path exists.
6. **`HarnessConfig.model` is dead.** `src/config/config.ts:12` declares it, and no call site in
   `src/` reads it. There is no defaults/user/project/org/session layer stack — `mergeConfigLayers`
   takes an arbitrary ordered array (`src/config/config.ts:40`). Section 6's assumption of a
   layered config resolution that model config sits inside is wrong.
7. **`ModelProviderRegistry` is never used for selection.** Nothing resolves a provider by name out
   of it at runtime (`src/models/registry.ts:3`); its only consumer is the plugin loader
   (`src/plugins/plugins.ts:57`). Provider choice is an `if/else` chain over env vars at two call
   sites.
8. **Tool-call ids and names are accumulated with `+=`.** `src/models/openai-compatible-provider.ts:147-148`.
   OpenAI/OpenRouter send the id once, so this works there. A gateway that repeats the full id or
   function name in every delta frame (observed behaviour on some vLLM and Ollama builds) yields
   `call-1call-1` / `echoecho` with no validation. This is a silent-corruption portability hazard.
9. **`usage` events are additive, not last-write-wins.** The provider yields a `usage` event for
   any chunk carrying `usage` (`src/models/openai-compatible-provider.ts:118-128`) and
   `BudgetTracker.add` accumulates (`src/services/limits.ts:20`). A backend that emits _cumulative_
   usage per chunk instead of once at the end will over-count the budget and can trip
   `BUDGET_EXCEEDED` spuriously.
10. **`.env` in the working tree contains a live `OPENROUTER_API_KEY` value** (`.env:4`). Value not
    reproduced here. It is gitignored (`.gitignore`), but it is present on disk.
11. **`assertModelAvailable()` is never called from production code.** Only tests and the README
    reference it. Good news for air-gap: there is no startup catalog fetch. The README claim at
    `README.md:19-20` overstates what runs.

## 1. The provider port

Contract lives in `src/models/provider.ts`. Full file content of the contract, verbatim.

`ModelProvider` — `src/models/provider.ts:36`:

```ts
export interface ModelProvider {
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

`ModelRequest` — `src/models/provider.ts:21`:

```ts
export type ModelRequest = {
  messages: readonly AgentMessage[];
  systemPrompt?: string;
  model?: string;
  tools: readonly ToolDescriptor[];
  maxOutputTokens?: number;
  signal: AbortSignal;
};
```

### Stream event union, verbatim, every variant

`src/models/provider.ts:30`:

```ts
export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'completed'; stopReason: StopReason };
```

Four variants. No `thinking`/`reasoning` variant, no `tool_call_delta` variant, no
`stream_started`, no `error` variant (errors are thrown, not yielded).

### Tool call representation: assembled, emitted once complete

Assembled and emitted once, never as fragments. The port has no partial-tool-call event, so the
adapter must buffer. Buffer type — `src/models/openai-compatible-provider.ts:34`:

```ts
type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
};
```

Emission is deferred to `finish_reason` arrival (`src/models/openai-compatible-provider.ts:152-156`)
or to stream end (`:159-163`). Consequence for portability: a `tool_call` never surfaces to the
session until the turn is finishing, so no streaming tool-argument UI is possible, and a backend
that streams a long argument blob produces no observable progress.

### Usage normalization

`ModelUsage` — `src/models/provider.ts:13`:

```ts
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
};
```

Wire mapping — `src/models/openai-compatible-provider.ts:118`:

```ts
      const usage = asRecord(chunk.usage);
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: numberValue(usage.prompt_tokens),
            outputTokens: numberValue(usage.completion_tokens),
            ...(typeof usage.cost === 'number' ? { estimatedCostUsd: usage.cost } : {}),
          },
        };
      }
```

`cacheReadTokens` / `cacheWriteTokens` are declared on the type but **never populated by any
adapter** — NOT FOUND in `src/models/`. `estimatedCostUsd` is read from a non-standard `usage.cost`
field, which is an OpenRouter extension; Bedrock and vLLM do not emit it, so cost budgets silently
become no-ops on those backends. `include_usage` is requested unconditionally via
`stream_options: { include_usage: true }` (`src/models/openai-compatible-provider.ts:83`).

### Stop reason normalization

`StopReason` — `src/models/provider.ts:4`:

```ts
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'max_turns'
  | 'cancelled'
  | 'budget_exceeded'
  | 'model_error';
```

Adapter mapping — `src/models/openai-compatible-provider.ts:280`:

```ts
function normalizeFinishReason(value: unknown): StopReason {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length' || value === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}
```

Note the fallthrough: `content_filter`, `error`, and any vendor-specific finish reason all become
`end_turn`. A refusal or filter stop is indistinguishable from a normal completion.
`max_turns` / `cancelled` / `budget_exceeded` / `model_error` are produced only by the session
(`src/core/agent-session.ts:277-320`), never by a provider.

### Error normalization

Errors are **thrown**, not yielded. All are `AgentHarnessError` (`src/core/errors.ts:1`) carrying a
string `code` and a boolean `recoverable`, with an HTTP `status` attached via `Object.assign` where
applicable.

| Code                       | Site                                 | recoverable          | Notes                             |
| -------------------------- | ------------------------------------ | -------------------- | --------------------------------- |
| `MODEL_API_ERROR`          | `openai-compatible-provider.ts:96`   | 408/409/429/5xx      | `status` attached                 |
| `EMPTY_MODEL_STREAM`       | `openai-compatible-provider.ts:108`  | false                |                                   |
| `MODEL_STREAM_ERROR`       | `openai-compatible-provider.ts:116`  | false                | in-band `error` object in a chunk |
| `MALFORMED_MODEL_STREAM`   | `openai-compatible-provider.ts:269`  | false                | unparseable SSE JSON              |
| `MALFORMED_TOOL_CALL`      | `openai-compatible-provider.ts:208`  | false                | missing id or name                |
| `MALFORMED_TOOL_JSON`      | `openai-compatible-provider.ts:214`  | false                | unparseable arguments             |
| `MISSING_MODEL_CREDENTIAL` | `openrouter-provider.ts:70`          | false                |                                   |
| `UNKNOWN_MODEL`            | `openrouter-provider.ts:123`         | false                |                                   |
| `MODEL_CATALOG_ERROR`      | `openrouter-provider.ts:161`, `:172` | 429/5xx on the first |                                   |
| `SCRIPT_EXHAUSTED`         | `scripted-provider.ts:22`            | false                |                                   |

There is **no `CONTEXT_WINDOW_EXCEEDED` code**. Context overflow is detected heuristically by
string matching in the session, not by the provider — `src/core/agent-session.ts:651`:

```ts
function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return (
    status === 413 ||
    /prompt.{0,20}(too long|context|large)|context.{0,20}(window|length|limit)/i.test(error.message)
  );
}
```

That regex is tuned to OpenRouter/OpenAI prose. vLLM's message
(`This model's maximum context length is ... tokens`) matches on `context ... length`; Ollama's
wording is not guaranteed to match. Portability risk, flagged.

### Cancellation

`AbortSignal`, carried on the request — `src/models/provider.ts:27` (`signal: AbortSignal`,
non-optional). No `cancel()` method on the port. Checked in three places in the adapter:

- pre-flight: `src/models/openai-compatible-provider.ts:55`
- handed to `fetch`: `src/models/openai-compatible-provider.ts:60`
- per read iteration in the SSE reader: `src/models/openai-compatible-provider.ts:235`

Signal origin is the session's `AbortController` (`src/core/agent-session.ts:165`), aborted by
`interrupt()` (`src/core/agent-session.ts:389`).

### Capabilities / limits declaration

**NOT FOUND.** No `ModelCapabilities`, `ProviderCapabilities`, `ModelLimits`, or equivalent type
exists in `src/models/`. The nearest thing is the OpenRouter catalog row, which is
OpenRouter-shaped and unused outside tests — `src/models/openrouter-provider.ts:33`:

```ts
export type OpenRouterModel = {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens?: number;
  supportsTools: boolean;
  inputModalities: readonly string[];
  promptUsdPerToken?: number;
  completionUsdPerToken?: number;
};
```

This matters exactly as the task anticipated: nothing in the harness can ask a provider whether it
supports tool calling or what its context window is, so a per-backend context budget cannot be
derived and an on-prem model without tool support fails only at request time.

## 2. The OpenRouter adapter

`src/models/openrouter-provider.ts`. The class is a **thin credential/attribution/routing wrapper**.
It owns no wire code.

```ts
export class OpenRouterModelProvider implements ModelProvider {        // :59
  readonly name = 'openrouter';                                        // :60
  readonly defaultModel: string;
  readonly baseURL: string;
  private readonly apiKey: string;
  private readonly delegate: OpenAICompatibleModelProvider;
  private readonly fetchImplementation: typeof fetch;
```

```ts
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {     // :94
    return this.delegate.stream(request);
  }
```

Delegate construction — `src/models/openrouter-provider.ts:81`:

```ts
this.delegate = new OpenAICompatibleModelProvider({
  name: 'openrouter',
  apiKey: this.apiKey,
  baseURL: this.baseURL,
  defaultModel: this.defaultModel,
  // OpenRouter normalizes on `max_tokens` across every upstream vendor.
  maxTokensField: 'max_tokens',
  defaultHeaders: openRouterHeaders(options),
  ...(routing === undefined ? {} : { extraBody: routing }),
  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
});
```

### HTTP request construction

All of it is in the shared adapter — `src/models/openai-compatible-provider.ts:56-92`:

```ts
const response = await this.fetchImplementation(
  `${this.options.baseURL.replace(/\/$/, '')}/chat/completions`,
  {
    method: 'POST',
    signal: request.signal,
    headers: {
      authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
      ...this.options.defaultHeaders,
    },
    body: JSON.stringify({
      model: request.model ?? this.options.defaultModel,
      messages: toCompatibleMessages(request.messages, request.systemPrompt),
      // Some upstream vendors reject an empty `tools` array.
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxOutputTokens === undefined
        ? {}
        : {
            [this.options.maxTokensField ?? 'max_completion_tokens']: request.maxOutputTokens,
          }),
      ...this.options.extraBody,
    }),
  },
);
```

- Path: `{baseURL}/chat/completions`, single trailing slash stripped.
- Auth: `authorization: Bearer <apiKey>`, not overridable — `defaultHeaders` is spread _after_, so
  a caller _could_ override `authorization` by supplying that key, but the platform header
  allowlist (§7) strips it.
- Streaming flag: `stream: true`, always. Non-streaming mode does not exist.
- `stream_options: { include_usage: true }` is unconditional. Some on-prem OpenAI-compatible
  servers reject unrecognized body fields; this is an untested risk for Ollama.
- OpenRouter-only field-name divergence handled via `maxTokensField`: `max_tokens` for OpenRouter,
  `max_completion_tokens` default otherwise.

### The SSE parsing loop, in full

Frame reader — `src/models/openai-compatible-provider.ts:226`:

```ts
async function* readSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw new AgentAbortError();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) {
        const data = buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

Behaviour notes: frames split on blank line, CRLF tolerant; multi-line `data:` joined with `\n`;
non-`data:` lines (`event:`, `id:`, `:` keep-alive comments) discarded; trailing partial buffer is
re-parsed at `done`, so a truncated final frame is _attempted_ rather than dropped.

Consumer loop — `src/models/openai-compatible-provider.ts:110-164`:

```ts
    const pending = new Map<number, PendingToolCall>();
    let completed = false;
    for await (const payload of readSse(response.body, request.signal)) {
      if (payload === '[DONE]') break;
      const chunk = parseChunk(payload);
      if ('error' in chunk && chunk.error) {
        throw new AgentHarnessError(formatApiError(chunk.error), 'MODEL_STREAM_ERROR');
      }
      const usage = asRecord(chunk.usage);
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: numberValue(usage.prompt_tokens),
            outputTokens: numberValue(usage.completion_tokens),
            ...(typeof usage.cost === 'number' ? { estimatedCostUsd: usage.cost } : {}),
          },
        };
      }
      for (const choiceValue of arrayValue(chunk.choices)) {
        const choice = asRecord(choiceValue);
        if (!choice) continue;
        const delta = asRecord(choice.delta);
        if (delta && typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', delta: delta.content };
        }
        for (const callValue of arrayValue(delta?.tool_calls)) {
          const call = asRecord(callValue);
          if (!call) continue;
          const index = numberValue(call.index);
          const details = asRecord(call.function);
          const current = pending.get(index) ?? {
            id: '',
            name: '',
            arguments: '',
            emitted: false,
          };
          if (typeof call.id === 'string') current.id += call.id;
          if (typeof details?.name === 'string') current.name += details.name;
          if (typeof details?.arguments === 'string') current.arguments += details.arguments;
          pending.set(index, current);
        }
        if (!completed && choice.finish_reason !== null && choice.finish_reason !== undefined) {
          yield* emitPendingToolCalls(pending);
          yield { type: 'completed', stopReason: normalizeFinishReason(choice.finish_reason) };
          completed = true;
        }
      }
    }
    if (!completed) {
      const emitted = [...emitPendingToolCalls(pending)];
      for (const event of emitted) yield event;
      yield { type: 'completed', stopReason: emitted.length ? 'tool_use' : 'end_turn' };
    }
```

Chunk JSON guard — `src/models/openai-compatible-provider.ts:263`:

```ts
function parseChunk(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new AgentHarnessError(
      'Model returned malformed SSE JSON',
      'MALFORMED_MODEL_STREAM',
      false,
      {
        cause,
      },
    );
  }
}
```

A single unparseable frame is fatal to the turn. `reasoning` / `reasoning_content` deltas (emitted
by OpenRouter for reasoning models, by SGLang, and by GLM-family models on bedrock-mantle) are
**silently discarded** — only `delta.content` is read (`:133`). No `NOT FOUND` marker needed: the
handling genuinely does not exist.

### Fragmented tool-call assembly

Keyed by `call.index` in a `Map<number, PendingToolCall>` (`:110`, `:139`). Accumulation is plain
string concatenation for `id`, `function.name`, and `function.arguments` (`:147-149`).

Assembly and JSON parse — `src/models/openai-compatible-provider.ts:204`:

```ts
function* emitPendingToolCalls(pending: Map<number, PendingToolCall>): Generator<ModelStreamEvent> {
  for (const [, call] of [...pending.entries()].sort(([left], [right]) => left - right)) {
    if (call.emitted) continue;
    if (!call.id || !call.name) {
      throw new AgentHarnessError('Model returned an incomplete tool call', 'MALFORMED_TOOL_CALL');
    }
    let input: unknown = {};
    try {
      input = call.arguments ? JSON.parse(call.arguments) : {};
    } catch (cause) {
      throw new AgentHarnessError(
        `Model returned malformed JSON for tool ${call.name}`,
        'MALFORMED_TOOL_JSON',
        false,
        { cause },
      );
    }
    call.emitted = true;
    yield { type: 'tool_call', id: call.id, name: call.name, input };
  }
}
```

Fragmented JSON arguments: concatenated verbatim, parsed exactly once at the end. No incremental
parse, no repair, no partial-JSON tolerance. Empty `arguments` becomes `{}`.

When arguments arrive fragmented and the stream is cut mid-fragment, the `!completed` tail path
(`:159`) still calls `emitPendingToolCalls`, so the half-written JSON throws `MALFORMED_TOOL_JSON`
with `recoverable: false`. That propagates out of the session's model loop and terminates the
session with `session.completed { reason: 'model_error' }` (`src/core/agent-session.ts:302-320`) —
it is **not** returned to the model as a recoverable tool error. Ordering on emit is by `index`
ascending, so parallel calls arrive deterministically.

### `listOpenRouterModels()` and `assertModelAvailable()`

`src/models/openrouter-provider.ts:140`:

```ts
export async function listOpenRouterModels(
  options: ListOpenRouterModelsOptions = {},
): Promise<OpenRouterModel[]> {
```

Calls `GET {baseURL}/models` with `accept: application/json` and an optional bearer
(`src/models/openrouter-provider.ts:150-158`). On `!response.ok` it throws `MODEL_CATALOG_ERROR`
with `recoverable` set for 429/5xx and `status` attached (`:159-168`). A non-array `data` payload
throws `MODEL_CATALOG_ERROR` (`:172`). Row mapping is `toOpenRouterModel`
(`src/models/openrouter-provider.ts:201`) and reads OpenRouter-specific fields:
`context_length`, `architecture.input_modalities`, `pricing.prompt`, `pricing.completion`,
`top_provider.max_completion_tokens`, `supported_parameters` (tools detected by
`supportedParameters.includes('tools')`, `:224`).

`src/models/openrouter-provider.ts:100` / `:111` / `:118`:

```ts
  async listModels(
    options: Omit<ListOpenRouterModelsOptions, 'apiKey' | 'baseURL' | 'fetch'> = {},
  ): Promise<OpenRouterModel[]>
```

```ts
  async findModel(model: string, signal?: AbortSignal): Promise<OpenRouterModel | undefined>
```

```ts
  async assertModelAvailable(model = this.defaultModel, signal?: AbortSignal): Promise<void>
```

`assertModelAvailable` calls `findModel` → `listModels` → `listOpenRouterModels`, and throws
`UNKNOWN_MODEL` when the slug is absent (`:122-127`).

**When they run: never, in production.** Repo-wide, the only callers are
`tests/models/openrouter-provider.test.ts:205`, `:207`, `:231` and prose in `README.md:19`.
No adapter, service, gateway, or platform path invokes either. `findModel` does a full catalog
fetch per call — no caching — so wiring it into a startup path would add a hosted round trip per
session.

### OpenRouter-specific request/response surface

| Item                       | Path                                                 | Detail                                                                                 |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Base URL constant          | `src/models/openrouter-provider.ts:5`                | `'https://openrouter.ai/api/v1'`                                                       |
| Attribution headers        | `src/models/openrouter-provider.ts:181-189`          | `HTTP-Referer`, `X-OpenRouter-Title` from `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` |
| Provider routing           | `src/models/openrouter-provider.ts:191-199`          | `provider` body field from `providerRouting`                                           |
| Fallback model array       | `src/models/openrouter-provider.ts:195-197`          | `models: [...]` body field from `fallbackModels`                                       |
| `max_tokens` normalization | `src/models/openrouter-provider.ts:86-87`            | forces `max_tokens` over `max_completion_tokens`                                       |
| `usage.cost`               | `src/models/openai-compatible-provider.ts:125`       | OpenRouter extension, read unconditionally                                             |
| Extra-body escape hatch    | `src/models/openai-compatible-provider.ts:17`, `:89` | `extraBody` is how routing is injected                                                 |

Slug parsing: **NOT FOUND.** No code splits or validates `vendor/model`. The `vendor/model` shape
is a documentation convention (`README.md:18`) and a Zod string of max length 300
(`src/platform/definitions.ts:14`). `:free` / `:nitro` variant handling: **NOT FOUND** — variants
pass through as opaque strings (a `:free` slug is in use at `.env:9` and
`examples/platform/setup-web-search-agent.ts:9`). Fallback-model arrays exist only as the
OpenRouter `models` body field above; there is no harness-level fallback across providers.

## 3. The OpenAI-compatible adapter

- Path: `src/models/openai-compatible-provider.ts`
- Class: `OpenAICompatibleModelProvider` (`:41`), `readonly name` defaults to
  `'openai-compatible'` and is overridable via `options.name` (`:50`).

Options — `src/models/openai-compatible-provider.ts:5`:

```ts
export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  name?: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  /**
   * Output-limit field name. OpenAI-style gateways expect
   * `max_completion_tokens`; OpenRouter normalizes on `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Gateway-specific request fields merged into the JSON body. */
  extraBody?: Readonly<Record<string, unknown>>;
  fetch?: typeof fetch;
};
```

### Difference from the OpenRouter adapter

Parsing is **100% shared** — there is no duplication to reconcile. `OpenRouterModelProvider` adds
only: credential/base-URL/model env defaults, attribution headers, `provider` + `models` routing
body fields, the `max_tokens` field choice, and the catalog methods. Everything from request
assembly through SSE parsing, tool assembly, usage mapping, stop-reason normalization, and error
classification is the compatible adapter's.

Validation differences worth noting: the compatible adapter throws plain `Error` for a blank key
(`:46`) and a blank model (`:47`), whereas OpenRouter throws a coded `AgentHarnessError`
`MISSING_MODEL_CREDENTIAL` (`:70`). Inconsistent error taxonomy across the two.

### Operator allowlist

Declared as a resolver option, not in the adapter — `src/platform/model-resolver.ts:12`:

```ts
export type DefaultPlatformModelResolverOptions = {
  allowedCustomBaseURLs?: ReadonlySet<string>;
};
```

Populated from env at `src/platform/mongodb-platform-service.ts:73-80`:

```ts
    models: new DefaultPlatformModelResolver(secrets, {
      allowedCustomBaseURLs: new Set(
        (process.env.PLATFORM_ALLOWED_MODEL_BASE_URLS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    }),
```

Validator and rejection error — `src/platform/model-resolver.ts:57`:

```ts
  private assertAllowedCustomBaseURL(value: string): void {
    const normalized = normalizeBaseURL(value);
    const allowed = [...(this.options.allowedCustomBaseURLs ?? [])].some(
      (candidate) => normalizeBaseURL(candidate) === normalized,
    );
    if (!allowed) throw new Error(`Model base URL is not trusted by this platform: ${normalized}`);
  }
```

```ts
function normalizeBaseURL(value: string): string {
  // :66
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Model base URL cannot contain credentials');
  return url.toString().replace(/\/$/, '');
}
```

Trigger condition — `src/platform/model-resolver.ts:30-35`:

```ts
if (
  binding.provider === 'openai-compatible' ||
  (binding.baseURL && normalizeBaseURL(binding.baseURL) !== OPENROUTER_BASE_URL)
) {
  this.assertAllowedCustomBaseURL(baseURL);
}
```

Rejection surfaces as a bare `Error` (untyped, no `AgentHarnessError` code), thrown during
`AgentExecutionPlatform.openSession` at `src/platform/execution.ts:88`, so session creation fails
rather than the first turn. `http://` is accepted (no TLS requirement) and there is no private-IP
or SSRF restriction on model base URLs — deliberate-looking, and convenient for on-prem.

**Note the enforcement gap:** the allowlist lives only in `DefaultPlatformModelResolver`. It does
**not** apply to `src/service/index.ts:66` (`MODEL_BASE_URL` env, unvalidated) or to any direct
`OpenAICompatibleModelProvider` construction in SDK use.

### Can it take an arbitrary base URL + model + credential today, no code change?

**Yes, on the platform path, with two operator prerequisites.** Exact config path:

1. Operator env: `PLATFORM_ALLOWED_MODEL_BASE_URLS=https://bedrock-mantle.us-east-1.api.aws/v1`
   (`src/platform/mongodb-platform-service.ts:75`).
2. Tenant secret env: `PLATFORM_SECRET_<TENANT>__MODEL_KEY=<credential>`
   (`src/platform/catalogs.ts:284-287`).
3. Agent-version definition body (`POST /v1/agents/{id}/versions`), `definition.model`:

```json
{
  "provider": "openai-compatible",
  "model": "zai.glm-5",
  "secretRef": "MODEL_KEY",
  "baseURL": "https://bedrock-mantle.us-east-1.api.aws/v1"
}
```

That is schema-valid per `src/platform/definitions.ts:11-24` and resolves to
`OpenAICompatibleModelProvider` wrapped in `RetryModelProvider` (`src/platform/model-resolver.ts:45-53`).

**Yes, on the service path, unvalidated:** `AGENT_PROVIDER=openai-compatible` +
`MODEL_BASE_URL` + `AGENT_MODEL` + `MODEL_API_KEY` (`src/service/index.ts:59-70`).

**No, on the CLI path.** `src/adapters/cli/index.ts:25` offers only OpenRouter or the scripted echo
stub. There is no env or flag that points `npm run agent` at another endpoint.

Caveats that make "no code change" partially true for the two new backends:
`Bearer`-only auth (§Surprises 5), the header allowlist dropping everything non-OpenRouter
(§Surprises 4), and the non-empty-credential requirement (§Surprises 3).

## 4. Tool schema conversion

Conversion happens **inside the provider**, at the request-body build —
`src/models/openai-compatible-provider.ts:70-81`:

```ts
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
```

The boundary type is already JSON Schema, so the conversion is a rename plus an OpenAI envelope.
`ToolDescriptor` — `src/tools/tool.ts:6`:

```ts
export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
```

Produced from the tool's hand-written `jsonSchema` at `src/tools/registry.ts:30`:

```ts
  descriptors(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }
```

Each `Tool` carries both a Zod schema for validation and a separate JSON Schema for the wire
(`src/tools/tool.ts:30-31`). Builtins hand-write the JSON Schema (for example
`src/tools/builtin/bash.ts:16`); `src/platform/web-search-tool.ts:122` uses
`z.toJSONSchema(...)`; MCP tools pass the remote schema through verbatim
(`src/mcp/client.ts:92`). Two sources of truth per tool, with no test asserting they agree.

Shared or per-provider: the _envelope_ is per-provider (each adapter would repeat those 12 lines),
but nothing OpenAI-specific happens to the schema itself. The scripted provider ignores
`request.tools` entirely.

Provider-specific handling:

- `strict` mode: **NOT FOUND** anywhere in `src/`.
- `additionalProperties`: not touched by any provider. Individual tools set
  `additionalProperties: false` in their own schemas (`src/tools/builtin/bash.ts:24`,
  `src/tools/builtin/read-file.ts:30`, `src/tasks/task-tools.ts:90`, and six more). No injection,
  no stripping.
- Nested objects: no special handling — the schema is passed through opaquely, so nesting depends
  entirely on what the backend accepts.
- `parallel_tool_calls`: **NOT FOUND.** Never sent. Parallelism is whatever the backend does by
  default; the session then batches consecutive `concurrencySafe` tools itself
  (`src/core/agent-session.ts:349-371`).
- Empty tools array: omitted rather than sent as `[]` (`src/models/openai-compatible-provider.ts:69-81`).

## 5. Retry and error classification

`src/models/retry-provider.ts`. Applied by decoration, not inside adapters.

```ts
export type RetryProviderOptions = {
  // :4
  maxAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
};
```

```ts
export class RetryModelProvider implements ModelProvider {              // :11
  constructor(
    private readonly provider: ModelProvider,
    options: RetryProviderOptions = {},
  ) {
    this.name = `retry(${provider.name})`;
```

Defaults (`:23-26`): `maxAttempts = 3`, `initialDelayMs = 250`, `maximumDelayMs = 4_000`,
`isRetryable = defaultRetryable`.

Backoff — `src/models/retry-provider.ts:47`:

```ts
const delay = Math.min(this.maximumDelayMs, this.initialDelayMs * 2 ** (attempt - 1));
await abortableDelay(delay, request.signal);
```

Pure exponential, **no jitter**. Effective waits: 250 ms, 500 ms. Total added latency before final
failure is under a second.

Retry gate — `src/models/retry-provider.ts:38-46`:

```ts
if (emitted || attempt === this.maxAttempts || request.signal.aborted || !this.isRetryable(error)) {
  throw error;
}
```

`emitted` is the important one: once any event has been yielded, no retry — partial output is never
duplicated. Correct, and covered by `tests/security/security.test.ts:29`.

Classification — `src/models/retry-provider.ts:54`:

```ts
function defaultRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500;
}
```

Duplicated, independently, as the `recoverable` flag inside the adapter
(`src/models/openai-compatible-provider.ts:99-102`) and again with a narrower set for the catalog
(`src/models/openrouter-provider.ts:164`: `429 || >= 500`). Three places, one concept.

Everything without a numeric `status` is terminal. That includes `MALFORMED_MODEL_STREAM`,
`MODEL_STREAM_ERROR`, network-level `fetch` failures (`TypeError: fetch failed` — no `status`), and
DNS errors. A transient socket reset therefore does **not** retry.

### HTTP 429 specifically

Retried, indistinguishably from a 500. Detail:

- `Retry-After` is **NOT read anywhere in the repository.** Grep for `retry-after` / `Retry-After`
  across `src/`: no matches. The 429 path reads only `response.status` and the body text
  (`src/models/openai-compatible-provider.ts:93-106`).
- No distinction between a per-second/per-minute rate limit and a daily or monthly quota. Both get
  250 ms then 500 ms, then surface as `MODEL_API_ERROR`. Against OpenRouter free-tier daily
  request caps, the two retries are wasted requests that themselves count against the cap.
- `x-ratelimit-*` headers, `Retry-After` seconds-vs-HTTP-date parsing, budget-aware backoff:
  **NOT FOUND.**
- HTTP 402 (OpenRouter insufficient credit for the requested `max_tokens`, documented at
  `.env.example:12-14`) is **not** in the retryable set and not specially classified — it becomes a
  generic terminal `MODEL_API_ERROR`.

## 6. Model selection and configuration

### `DEFAULT_OPENROUTER_MODEL`

`src/models/openrouter-provider.ts:11`:

```ts
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';
```

Re-exported from the public API at `src/index.ts:23`.

### Env vars influencing model choice

| Var                                          | Read at                                                                                           | Precedence                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `AGENT_MODEL`                                | `src/adapters/cli/index.ts:15`, `src/service/index.ts:40`, `:69`                                  | 1st (CLI, service)                                            |
| `OPENROUTER_MODEL`                           | `src/adapters/cli/index.ts:15`, `src/service/index.ts:40`, `src/models/openrouter-provider.ts:78` | 2nd                                                           |
| `DEFAULT_OPENROUTER_MODEL`                   | `src/models/openrouter-provider.ts:11`                                                            | 3rd (constant)                                                |
| `OPENROUTER_BASE_URL`                        | `src/models/openrouter-provider.ts:76`, `:145`, `src/service/index.ts:41`                         | endpoint                                                      |
| `OPENROUTER_API_KEY`                         | `src/models/openrouter-provider.ts:68`, `:148`, `src/adapters/cli/index.ts:25`                    | credential, also selects the provider in the CLI              |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` | `src/models/openrouter-provider.ts:182-183`                                                       | attribution headers                                           |
| `OPENROUTER_FALLBACK_MODELS`                 | `src/service/index.ts:50-56`                                                                      | comma-separated `models` body field                           |
| `AGENT_PROVIDER`                             | `src/service/index.ts:12`                                                                         | `demo` \| `openrouter` \| `openai-compatible`, default `demo` |
| `MODEL_BASE_URL`                             | `src/service/index.ts:61`, `:68`                                                                  | openai-compatible endpoint                                    |
| `MODEL_API_KEY` / `OPENAI_API_KEY`           | `src/service/index.ts:60`                                                                         | openai-compatible credential                                  |
| `AGENT_MAX_OUTPUT_TOKENS`                    | `src/adapters/cli/index.ts:17`                                                                    | output cap                                                    |
| `AGENT_MAX_TURNS`                            | `src/adapters/cli/index.ts:21`                                                                    | turn cap                                                      |
| `PLATFORM_ALLOWED_MODEL_BASE_URLS`           | `src/platform/mongodb-platform-service.ts:75`                                                     | operator allowlist                                            |
| `PLATFORM_SECRET_*`                          | `src/platform/catalogs.ts:284-287`                                                                | tenant credential                                             |
| `PLATFORM_AGENT_MODEL`                       | `examples/platform/setup-agent.ts:30`, `setup-web-search-agent.ts:9`                              | example scripts only                                          |
| `AGENT_HARNESS_LIVE_OPENROUTER(_MODEL)`      | `tests/models/openrouter-provider.test.ts:229`, `:231`                                            | opt-in live test                                              |

Precedence chain, verbatim, identical in both entry points
(`src/adapters/cli/index.ts:15`, `src/service/index.ts:40`):

```ts
const model = process.env.AGENT_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
```

`OpenRouterModelProvider` applies its own inner fallback for a caller that passes nothing
(`src/models/openrouter-provider.ts:77-79`): `options.defaultModel ?? OPENROUTER_MODEL ??
DEFAULT_OPENROUTER_MODEL`. `AGENT_MODEL` is **not** visible to the provider itself — only to the two
entry points.

On the platform path, none of the above applies: the model is the stored
`definition.model.model` (`src/platform/execution.ts:88`, `:118`).

### `src/config/` layering

There is **no defaults/user/project/org/session stack.** The whole config module is 70 lines
(`src/config/config.ts`) and offers an ordered array with last-write-wins deep merge:

```ts
export type ConfigLayer = {
  // :35
  name: string;
  value: unknown;
};
```

```ts
export function mergeConfigLayers(layers: readonly ConfigLayer[]): HarnessConfig {
  // :40
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    const parsed = harnessConfigSchema.partial().parse(layer.value);
    merged = deepMerge(merged, parsed);
  }
  return harnessConfigSchema.parse(merged);
}
```

```ts
export async function loadJsonConfig(path: string): Promise<ConfigLayer>; // :49
```

Where model config sits in that stack: `harnessConfigSchema.model` at `src/config/config.ts:12`
(`model: z.string().optional()`), plus `limits.maxOutputTokens` / `limits.maxInputTokens` at `:18-19`.
**Nothing reads them.** Repo-wide consumers of `mergeConfigLayers` / `HarnessConfig`:
`src/index.ts:135-136` (re-export) and `tests/extensions/extensions.test.ts:18`. No adapter,
service, or session path loads a config file. The layered config is, today, an unused library.

### Runtime selection vs. hardcoded call sites

Selection is by `if`/`else` over env vars at two entry points; there is no provider factory or
name-based lookup. `ModelProviderRegistry` (`src/models/registry.ts:3`) supports
`register`/`get`/`list` but nothing calls `.get()` to build a session — its only wiring is the
plugin `providers` capability (`src/plugins/plugins.ts:57`, `:89-94`).

Every concrete provider construction in `src/` and `examples/`:

| Path:line                               | Constructs                                                  | Selection                             |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `src/adapters/cli/index.ts:26`          | `new OpenRouterModelProvider`                               | `if (process.env.OPENROUTER_API_KEY)` |
| `src/adapters/cli/index.ts:27`          | `new ScriptedModelProvider`                                 | else branch (echo stub)               |
| `src/service/index.ts:32`               | `createAgentCoreDemoProvider()`                             | `AGENT_PROVIDER=demo` (default)       |
| `src/service/index.ts:37`               | `createOpenRouterProvider(...)`                             | `AGENT_PROVIDER=openrouter`           |
| `src/service/index.ts:66`               | `new OpenAICompatibleModelProvider`                         | `AGENT_PROVIDER=openai-compatible`    |
| `src/service/agent-core-service.ts:89`  | `new ScriptedModelProvider`                                 | demo factory                          |
| `src/models/openrouter-provider.ts:81`  | `new OpenAICompatibleModelProvider`                         | delegate                              |
| `src/models/openrouter-provider.ts:137` | `new OpenRouterModelProvider`                               | `createOpenRouterProvider` factory    |
| `src/platform/model-resolver.ts:38`     | `new OpenRouterModelProvider` in `RetryModelProvider`       | `binding.provider === 'openrouter'`   |
| `src/platform/model-resolver.ts:47`     | `new OpenAICompatibleModelProvider` in `RetryModelProvider` | else branch                           |
| `src/services/provider-auth.ts:17`      | `new OpenRouterModelProvider`                               | OpenRouter-only helper                |
| `examples/sdk/basic.ts:3`, `:6`         | `new ScriptedModelProvider`                                 | example                               |

Only `src/platform/model-resolver.ts` is data-driven; everything else is env-driven branching.
Note that `RetryModelProvider` is applied **only** on the platform path — CLI, service, and SDK
sessions have no retry at all.

## 7. Platform credential resolution

### Stored agent version → credential at execution time

Chain: `AgentExecutionPlatform.openSession` resolves the deployment, then
`src/platform/execution.ts:88`:

```ts
const provider = await this.options.models.resolve(
  principal.tenantId,
  resolved.version.definition.model,
);
```

`src/platform/model-resolver.ts:8`:

```ts
export interface PlatformModelResolver {
  resolve(tenantId: string, binding: ModelBinding): Promise<ModelProvider>;
}
```

```ts
  async resolve(tenantId: string, binding: ModelBinding): Promise<ModelProvider> {   // :22
    const apiKey = await this.secrets.get(tenantId, binding.secretRef);
    if (!apiKey) throw new Error(`Missing model credential: ${binding.secretRef}`);
```

So: the version stores a `secretRef` **name**, never a secret value; the value is fetched per
session open from the tenant-scoped resolver. Resolution is per session, not per turn, and not
cached across sessions.

### Tenant secret namespace

`src/platform/catalogs.ts:262`:

```ts
export interface PlatformSecretResolver {
  get(tenantId: string, reference: string): Promise<string | undefined>;
}
```

`src/platform/catalogs.ts:276`:

```ts
export class EnvironmentPlatformSecretResolver implements PlatformSecretResolver {
  constructor(
    private readonly prefix = 'PLATFORM_SECRET_',
    private readonly allowGlobalFallback = false,
  ) {}

  async get(tenantId: string, reference: string): Promise<string | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error('Invalid secret reference');
    const tenant = tenantId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    return (
      process.env[`${this.prefix}${tenant}__${reference}`] ??
      (this.allowGlobalFallback ? process.env[`${this.prefix}${reference}`] : undefined)
    );
  }
}
```

`PLATFORM_SECRET_TENANT_A__OPENROUTER_API_KEY` decomposes as prefix `PLATFORM_SECRET_` + tenant
`tenant-a` → `TENANT_A` (non-alphanumerics to `_`, uppercased) + `__` + reference
`OPENROUTER_API_KEY` (regex-validated to prevent env traversal). Global fallback
`PLATFORM_SECRET_<REF>` is opt-in via `PLATFORM_ALLOW_GLOBAL_SECRETS=true`
(`src/platform/mongodb-platform-service.ts:67-70`). Tenant isolation is asserted at
`tests/platform/catalogs.test.ts:11`; the operator-facing form is documented at `README.md:192`.

One collision hazard worth noting: the tenant mangling is not injective — tenants `a-b` and `a_b`
both map to `A_B` and would share secrets.

### Trusted model endpoints check

Enforced in `DefaultPlatformModelResolver.assertAllowedCustomBaseURL`
(`src/platform/model-resolver.ts:57`), quoted in §3. What it validates:

1. URL parses (`new URL`), else throws.
2. No embedded credentials in userinfo (`src/platform/model-resolver.ts:68`).
3. Normalized string equality against the allowlist set (`:59-61`) — exact host+port+path match, no
   prefix or wildcard matching, no scheme constraint.

Triggered for every `openai-compatible` binding, and for any `openrouter` binding whose `baseURL`
is not exactly `OPENROUTER_BASE_URL` (`:30-35`) — that second clause is what stops a compromised
database row from re-pointing an OpenRouter agent at an attacker's gateway
(`tests/platform/model-resolver.test.ts:9`).

### Per-version or global?

**Both, and they interact.** The URL is stored **per agent version** —
`src/platform/definitions.ts:11`:

```ts
export const modelBindingSchema = z
  .object({
    provider: z.enum(['openrouter', 'openai-compatible']).default('openrouter'),
    model: z.string().min(1).max(300),
    secretRef: identifier,
    baseURL: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === 'openai-compatible' && !value.baseURL) {
      context.addIssue({ code: 'custom', message: 'openai-compatible model requires baseURL' });
    }
  });
```

The **allowlist** that authorizes it is global operator config
(`PLATFORM_ALLOWED_MODEL_BASE_URLS`). Per-version URL, globally allowlisted. That is the right
shape for the target architecture.

The `provider` enum is the blocking detail: it accepts only `'openrouter' | 'openai-compatible'`.
Adding first-class `'bedrock'` or `'on-prem'` names requires editing `src/platform/definitions.ts:13`
and `src/platform/model-resolver.ts:36`. Riding on `'openai-compatible'` needs no change.

`headers` is accepted by the schema and then almost entirely discarded —
`src/platform/model-resolver.ts:72`:

```ts
function safeModelHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const safe = new Set(['HTTP-Referer', 'X-OpenRouter-Title', 'X-OpenRouter-Categories']);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => safe.has(name)));
}
```

## 8. Provider contract tests

**No provider conformance suite exists.** There is no shared test that accepts a `ModelProvider`
and exercises the contract. What exists:

| Path                                              | Scope                                                 |
| ------------------------------------------------- | ----------------------------------------------------- |
| `tests/models/openai-compatible-provider.test.ts` | 3 tests, adapter-specific, injected `fetch`           |
| `tests/models/openrouter-provider.test.ts`        | 7 tests (1 skipped live), adapter-specific            |
| `tests/platform/model-resolver.test.ts`           | 2 tests, allowlist behaviour                          |
| `tests/security/security.test.ts:29`              | retry provider, no partial-output duplication         |
| `tests/core/session.test.ts`                      | 7 tests, session loop against `ScriptedModelProvider` |
| `tests/parity/parity.test.ts`                     | see below                                             |

`src/testing/parity-runner.ts` looks like a candidate but is **not** a provider suite. Its
signature — `src/testing/parity-runner.ts:18`:

```ts
export async function runParityScenario(
  primaryFactory: () => AgentSession | Promise<AgentSession>,
  candidateFactory: () => AgentSession | Promise<AgentSession>,
  prompt: string,
): Promise<ParityResult>;
```

It diffs normalized `AgentEvent` streams between two **sessions**, not two providers, and
`normalizeEvent` (`:53`) drops `usage.updated` entirely — so it cannot detect usage divergence
between backends. It could be pointed at two sessions with different providers, but no test does.

Runnable against an arbitrary provider instance: **no.** Each provider test constructs its own
concrete class with a stub `fetch`. Session tests hardcode `ScriptedModelProvider`.

### Coverage matrix

| Case                                   | Status                                                 | Evidence                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single valid tool call                 | **PRESENT**                                            | `tests/models/openai-compatible-provider.test.ts:33`, `tests/models/openrouter-provider.test.ts:42` — both include fragmented arguments (`'{"val'` + `'ue":"ok"}'`)                                                                    |
| multiple parallel tool calls           | **ABSENT**                                             | no test supplies two `tool_calls` indices. `tests/core/session.test.ts:137` exercises parallel _tool execution_ from a scripted provider, which never touches multi-index SSE assembly                                                 |
| malformed / unparseable tool arguments | **PRESENT**                                            | `tests/models/openrouter-provider.test.ts:107` asserts `/malformed JSON/`                                                                                                                                                              |
| unknown tool name                      | **PRESENT at session level, ABSENT at provider level** | `src/core/agent-session.ts:406-410` returns `Unknown tool: ...` as a tool error; no test asserts it, and it is not a provider concern                                                                                                  |
| mid-stream cancellation                | **ABSENT at provider level**                           | no test aborts a signal during `readSse`. `tests/core/session.test.ts:175` interrupts a scripted provider, so the `readSse` abort check at `src/models/openai-compatible-provider.ts:235` and the pre-flight at `:55` are **untested** |
| stream truncated mid-tool-call         | **ABSENT**                                             | no test omits `finish_reason` and closes the stream. The `!completed` tail path (`:159-163`) and the `done`-with-partial-buffer path (`:248-256`) are both untested                                                                    |
| usage accounting accuracy              | **PARTIAL**                                            | single-chunk usage asserted in both adapter tests; multi-chunk / cumulative-usage double counting untested; `tests/services/services.test.ts:101` covers `BudgetTracker` in isolation                                                  |
| HTTP error mapping (4xx vs 5xx)        | **PARTIAL**                                            | 503 asserted twice (`openai-compatible-provider.test.ts:110`, `openrouter-provider.test.ts:211`). **No 429 test, no 4xx test, no 402 test.** The retryable classification for 408/409/429 is unasserted                                |
| context-window-exceeded error          | **PARTIAL, session level only**                        | `tests/context/reactive-compaction.test.ts:5` drives `isPromptTooLong` via a thrown error; no provider-level test that a 413 or a vendor context message maps correctly                                                                |

## 9. Context and limits

### Context window declaration

There is no per-provider or per-model context window. It is a **global default constant inside the
context manager** — `src/context/context-manager.ts:40`:

```ts
this.maxInputTokens = options.maxInputTokens ?? 100_000;
this.retainRecentMessages = options.retainRecentMessages ?? 8;
```

Overridable per request (`src/context/context-manager.ts:44`:
`const limit = request.maxInputTokens ?? this.maxInputTokens;`), sourced from
`AgentLimits.maxInputTokens` (`src/core/agent-session.ts:27`), which comes from
`definition.limits.maxInputTokens` on the platform (`src/platform/execution.ts:157-159`) or
`config.limits` in the SDK. Never from the provider or model.

Token counting is a character heuristic, not a tokenizer — `src/context/context-manager.ts:95`:

```ts
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  const characters = JSON.stringify(messages).length;
  return Math.max(1, Math.ceil(characters / 4));
}
```

`chars / 4` over the JSON envelope (so structural braces and keys count as tokens). Divergence
across tokenizers is unbounded; for a 1M-context Claude slug versus a 128K on-prem model the same
100_000 default applies to both. `OpenRouterModel.contextLength` is available and unused.

### Compaction triggers

**Both**, and they are separate mechanisms:

1. **Proactive, token threshold** — `CompactingContextManager.prepare`
   (`src/context/context-manager.ts:43-48`): if `estimateMessagesTokens(messages) > limit`,
   summarize everything older than the last 8 messages, with a backward walk so a `tool_result` is
   never split from its `tool_call` (`:51-57`). Installed by default at
   `src/core/agent-session.ts:130`. Emits `context.compaction.started` / `.completed`
   (`src/core/agent-session.ts:213-225`).
2. **Reactive, error recovery** — `src/core/agent-session.ts:285`:

```ts
          if (isPromptTooLong(error) && reactiveCompactionAttempts < 1) {
            reactiveCompactionAttempts += 1;
            reactiveMaxInputTokens = Math.max(
              1_000,
              Math.floor(estimateMessagesTokens(this.messages) / 2),
            );
```

Halves the budget and replays the turn exactly once, gated by the `isPromptTooLong` regex quoted in
§1. Emits `warning { code: 'REACTIVE_COMPACTION' }`.

### `max_tokens` / max output configurability

Provider-configurable in two independent senses:

- **Value:** `ModelRequest.maxOutputTokens` (`src/models/provider.ts:26`), fed from
  `AgentLimits.maxOutputTokens` with a global default — `src/core/agent-session.ts:71`:

```ts
const DEFAULT_LIMITS: AgentLimits = { maxTurns: 24, maxOutputTokens: 8_192 };
```

Overridable via `AGENT_MAX_OUTPUT_TOKENS` (CLI, `src/adapters/cli/index.ts:17`),
`definition.limits.maxOutputTokens` (platform, `src/platform/execution.ts:160-162`), or
`config.limits` (SDK).

- **Wire field name:** `maxTokensField: 'max_tokens' | 'max_completion_tokens'`
  (`src/models/openai-compatible-provider.ts:15`), defaulting to `max_completion_tokens`
  (`:87`). The union is closed — a backend expecting some third name has no path.

Note the default direction: `DefaultPlatformModelResolver` does **not** set `maxTokensField` for
`openai-compatible` bindings (`src/platform/model-resolver.ts:45-53`), so those send
`max_completion_tokens`. vLLM and SGLang accept both; older Ollama OpenAI-compat builds accept only
`max_tokens`. Untested risk.

## 10. Coupling report

### Direct imports of `src/models/openrouter-provider.ts` from outside `src/models/`

| Path:line                          | Why coupled                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts:22-27`               | Public API re-exports `createOpenRouterProvider`, `DEFAULT_OPENROUTER_MODEL`, `listOpenRouterModels`, `OPENROUTER_BASE_URL`, `OpenRouterModelProvider` — deleting the module is a breaking SDK change |
| `src/index.ts:29-32`               | Public type re-exports `ListOpenRouterModelsOptions`, `OpenRouterModel`, `OpenRouterProviderOptions`                                                                                                  |
| `src/index.ts:221`                 | Re-exports `createOpenRouterProviderFromSecrets`                                                                                                                                                      |
| `src/adapters/cli/index.ts:5-7`    | Imports the class and default slug; OpenRouter is the CLI's only live backend                                                                                                                         |
| `src/service/index.ts:5-7`         | Imports the factory and default slug for the `AGENT_PROVIDER=openrouter` branch                                                                                                                       |
| `src/platform/model-resolver.ts:2` | Imports `OPENROUTER_BASE_URL` and the class; the constant is load-bearing in the trust check at `:32`                                                                                                 |
| `src/services/provider-auth.ts:1`  | Entire module exists only to build an OpenRouter provider from a `SecretProvider`                                                                                                                     |

### References to an OpenRouter URL, slug format, or vendor/model string shape

| Path:line                                                 | Why coupled                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/platform/model-resolver.ts:26-28`                    | Defaults a missing `baseURL` to `OPENROUTER_BASE_URL`, so "no URL" implicitly means "hosted OpenRouter"          |
| `src/platform/model-resolver.ts:32`                       | Trust decision is expressed as "differs from OpenRouter's URL" rather than "is a custom endpoint"                |
| `src/platform/model-resolver.ts:75`                       | Header allowlist is three OpenRouter header names; a vendor-neutral endpoint gets no headers                     |
| `src/platform/definitions.ts:13`                          | `provider` enum defaults to `'openrouter'`, so an omitted provider field means hosted                            |
| `src/models/openai-compatible-provider.ts:125`            | Reads `usage.cost`, an OpenRouter extension, in the shared adapter                                               |
| `src/core/agent-session.ts:651-658`                       | `isPromptTooLong` regex is tuned to OpenAI/OpenRouter error prose                                                |
| `examples/platform/setup-agent.ts:29-32`                  | Example agent definition hardcodes `provider: 'openrouter'` + `X-OpenRouter-Title`                               |
| `examples/platform/setup-web-search-agent.ts:9`, `:45-48` | Same, plus an OpenRouter `:free` variant slug as the default model                                               |
| `README.md:14-20`, `:62-63`                               | Documents OpenRouter as the routing layer for "every live model"                                                 |
| `.env.example:5-10`, `:27-28`                             | Presents `OPENROUTER_API_KEY` as "required for any live run" and `AGENT_PROVIDER` as `demo` or `openrouter` only |
| `.env:4`, `:8`                                            | Live key on disk plus a `:free` OpenRouter slug                                                                  |

### Assumes a hosted provider is reachable

| Path:line                                          | Why coupled                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/models/openrouter-provider.ts:100-127`        | `listModels` / `findModel` / `assertModelAvailable` require `GET /models` on a hosted catalog. **Not called from production code** (only `tests/models/openrouter-provider.test.ts` and `README.md:19-20`) — dormant, not active |
| `src/tools/web/search-provider.ts:4`               | `TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'` — `web_search` is hosted-only                                                                                                                                         |
| `src/platform/web-search-tool.ts:5`                | Same constant duplicated for the platform tool                                                                                                                                                                                   |
| `tests/models/openrouter-provider.test.ts:226-229` | Live network test, correctly gated behind `AGENT_HARNESS_LIVE_OPENROUTER`                                                                                                                                                        |

Startup network calls: **none for models.** No health check, no catalog prefetch, no token probe at
process start in any adapter, service, gateway, or platform path. Good news for air-gap, and worth
protecting.

### Would break in an air-gapped environment

| Path:line                                                                 | Why it breaks                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/cli/index.ts:25-33`                                         | Provider selection is `OPENROUTER_API_KEY ? OpenRouter : scripted echo`. With no internet, `npm run agent` cannot reach a local model at all — no env var, no flag, no code path. **This is the first thing that breaks.** |
| `src/models/openai-compatible-provider.ts:46`                             | Blank `apiKey` throws. An unauthenticated local vLLM/Ollama needs a fabricated credential                                                                                                                                  |
| `src/platform/model-resolver.ts:24`                                       | Missing secret throws before any request. Same problem, platform side                                                                                                                                                      |
| `src/models/openai-compatible-provider.ts:62`                             | `Bearer`-only auth; no mTLS, no custom header scheme, no SigV4                                                                                                                                                             |
| `src/platform/model-resolver.ts:75`                                       | Custom headers stripped, so a local gateway requiring `api-key:` or a tenant header cannot be reached                                                                                                                      |
| `src/platform/model-resolver.ts:26-28`                                    | A binding that omits `baseURL` silently targets the public internet instead of failing closed                                                                                                                              |
| `src/models/openai-compatible-provider.ts:83`                             | Unconditional `stream_options`; a strict on-prem server that rejects unknown body fields fails every request                                                                                                               |
| `src/context/context-manager.ts:40`                                       | 100_000-token default is wrong for most on-prem models (typically 8K–128K), and nothing derives it from the model                                                                                                          |
| `src/tools/web/search-provider.ts:4`, `src/platform/web-search-tool.ts:5` | `web_search` is unusable; `createWebTools` does register `web_fetch` only, and skips search without a key (`tests/tools/web-tools.test.ts:281`), so this degrades rather than crashes                                      |
| `examples/platform/setup-*.ts`                                            | Every example agent definition is unusable as written                                                                                                                                                                      |
| `.env.example`                                                            | No documented on-prem or self-hosted configuration example exists                                                                                                                                                          |

## 11. Verdict

### Can a new OpenAI-compatible backend be added today by config alone?

**Partially — yes on the platform and service paths, no on the CLI/SDK-default path, and not for
either target backend without touching code.**

Works by config alone:

- Platform: `provider: 'openai-compatible'` + `baseURL` + `secretRef` in a stored agent version,
  plus `PLATFORM_ALLOWED_MODEL_BASE_URLS` and a `PLATFORM_SECRET_*` env var. Exact payload in §3.
- Service: `AGENT_PROVIDER=openai-compatible` + `MODEL_BASE_URL` + `AGENT_MODEL` + `MODEL_API_KEY`.

Files that must change for the stated targets:

1. `src/adapters/cli/index.ts:25-33` — add provider selection; today the CLI cannot target anything
   but OpenRouter or the echo stub. Required for any on-prem developer workflow.
2. `src/models/openai-compatible-provider.ts:46` — allow an empty/absent credential for
   unauthenticated on-prem endpoints.
3. `src/models/openai-compatible-provider.ts:62` — make the auth scheme pluggable (header name +
   value, or a `getAuthHeaders()` hook) for SigV4-signed bedrock-mantle and for gateways using
   `api-key`.
4. `src/platform/model-resolver.ts:72-78` — replace the OpenRouter-specific `safeModelHeaders`
   allowlist with a per-provider allowlist, otherwise no Bedrock or on-prem header can be sent.
5. `src/platform/model-resolver.ts:26-28` — stop defaulting a missing `baseURL` to OpenRouter;
   fail closed.
6. `src/platform/definitions.ts:13` — extend the `provider` enum if `bedrock` / `on-prem` are to be
   first-class names rather than `openai-compatible` in disguise; change the default away from
   `'openrouter'`.
7. `src/models/openai-compatible-provider.ts:83` — make `stream_options` opt-out for strict servers.
8. `src/config/config.ts` + one consumer — wire `HarnessConfig.model` to something, or delete it;
   right now "config choice" is not a real mechanism outside the platform database.

### What breaks first with no internet access?

`npm run agent` (`src/adapters/cli/index.ts:25`). It silently falls back to a scripted echo stub
that just repeats the prompt, because provider selection is keyed on the presence of
`OPENROUTER_API_KEY`. There is no configuration that points the CLI at a local model. Failure mode
is worse than a crash: it looks like a working agent that produces nothing.

Second: any platform agent version whose `model` binding omits `baseURL`
(`src/platform/model-resolver.ts:26-28`) attempts `https://openrouter.ai/api/v1/chat/completions`
and fails on DNS. A DNS failure carries no `status`, so `defaultRetryable`
(`src/models/retry-provider.ts:54`) returns `false` and it terminates immediately as a
non-recoverable `model_error` — correct behaviour, opaque message.

Third: `web_search` is unavailable (`src/tools/web/search-provider.ts:4`). Degrades cleanly — the
tool is simply not registered without a key.

### Three changes with the best value-to-effort

1. **Add capabilities to the port, and drive limits from them.** Extend `ModelProvider` with a
   `capabilities` field (context window, max output, tool support, streaming, whether cost is
   reported, `maxTokensField`) and have `AgentSessionImpl` seed `CompactingContextManager` and
   `DEFAULT_LIMITS` from it instead of the global 100_000 / 8_192 constants
   (`src/context/context-manager.ts:40`, `src/core/agent-session.ts:71`). Small type change,
   additive, and it is the single missing piece that makes four backends behave predictably instead
   of sharing one backend's numbers. It also lets `CONTEXT_WINDOW_EXCEEDED` become a real error code
   and retires the `isPromptTooLong` regex (`src/core/agent-session.ts:651`).

2. **Make auth, headers, and credential-optionality per-backend.** Three narrow edits — the
   hardcoded `Bearer` at `src/models/openai-compatible-provider.ts:62`, the empty-key guard at
   `:46`, and `safeModelHeaders` at `src/platform/model-resolver.ts:72` — are what actually block
   bedrock-mantle and unauthenticated on-prem today. Everything else about those two backends
   already works through the existing adapter. Highest ratio of unblocked capability to lines
   changed.

3. **Write one provider conformance suite and run it against every backend.** A single exported
   `runProviderContractTests(factory: () => ModelProvider)` covering the nine cases in §8 —
   especially the six currently ABSENT ones: parallel tool calls, mid-stream cancellation,
   truncated-mid-tool-call, cumulative-vs-final usage, 429/4xx mapping, repeated-tool-call-id
   accumulation (`src/models/openai-compatible-provider.ts:147`). Moderate effort, and it is the
   only way to know a fourth backend works without a live account. Point it at `scripted`, at a
   stubbed `openrouter`, at a stubbed bedrock-mantle, and at a real local vLLM in CI.

Ordering rationale: (1) is the smallest change that removes a whole class of cross-backend bugs,
(2) unblocks the two new backends outright, (3) costs the most but is what keeps the other two
honest as backends are added.
