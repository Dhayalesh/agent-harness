# Web Research Agent Live Acceptance Result

Run date: 2026-07-22 (Asia/Kolkata)

## Outcome

The MongoDB-configured `web-research-agent` completed the question:

> Explain the principles of modern AI agent system design.

The successful run used OpenRouter model `poolside/laguna-s-2.1:free` and the
trusted Tavily `web_search@1` tool. It streamed a 15,852-character structured
answer and a numbered Sources section through the frontend-independent SSE API.

## Persisted identity

- Agent ID: `867238b8-8c5e-431f-910c-35565f949799`
- Successful execution version: 4
- Successful version ID: `69ef88b2-d776-47c0-a4c8-6ecdd601cc01`
- Successful session ID: `81d2857e-3c86-4d9e-87bf-5605e44dfdb6`
- Successful run ID: `810dfb04-85f0-4d2e-b468-abffe2aa9e00`
- Run state: `completed`
- Completion reason: `end_turn`

Version 5 is now deployed to production at deployment revision 5. It retains
the successful model and definition while adding a hard five-result ceiling and
a six-search per-session Tavily quota.

## Durable trajectory evidence

- 2,775 persisted protocol events
- 4 model turns
- 6 `web_search` requests
- 6 successful Tavily tool results
- 5–6 results per search before the final ceiling adjustment
- 30 unique returned source URLs
- 18 source URLs used in the final answer
- 0 answer URLs absent from the Tavily results
- approximately 31–32 KB of bounded evidence per search result set

The six persisted queries covered architecture principles, core agent
capabilities, reasoning/planning/memory/tool use, ReAct, multi-agent patterns,
and observability/security/governance.

## Model routing history

Immutable versions preserve every attempt:

1. `nvidia/nemotron-3-ultra-550b-a55b:free` — two runs reached OpenRouter but
   Nvidia returned `ResourceExhausted` at its free worker limit.
2. `openai/gpt-oss-20b:free` — Tavily search succeeded, but the model returned
   an empty final assistant message after receiving the tool result.
3. `google/gemma-4-31b-it:free` — Google’s free endpoint returned an upstream
   429 rate limit.
4. `poolside/laguna-s-2.1:free` — complete search-and-synthesis trajectory.
5. The Poolside definition plus final search-result and request-count ceilings;
   this is the current production deployment.
Can
## Quality observations

- The final answer was detailed and all emitted URLs came from retrieved tool
  evidence.
- The fallback model produced bare URLs in a numbered Sources section rather
  than the requested inline Markdown-link format.
- URL provenance does not prove that every claim is semantically supported.
  The generic search returned a mixture of official and secondary sources. A
  production research product should add source-quality scoring and a separate
  claim-to-citation verification pass.
- Free OpenRouter endpoints can be capacity-limited or model-specific in their
  tool behavior. Paid routing or an operator-approved fallback policy is
  recommended for predictable production execution.

## Verification

After implementation, formatting, strict TypeScript, build, and the complete
test suite passed: 76 tests total, 73 passed, and 3 credential-gated tests were
skipped by the default command. The live Atlas/OpenRouter/Tavily trajectory was
executed separately.

The current dependency audit also reports a moderate Windows-only static-file
path traversal advisory in `@hono/node-server@1.19.14`, transitively required by
the latest MCP SDK. The web-search service does not expose that static-file
handler. Upstream currently requires the vulnerable 1.x major, so this should be
tracked until the MCP SDK accepts Hono Node Server 2.0.5 or later rather than
forced through an unverified major override.
