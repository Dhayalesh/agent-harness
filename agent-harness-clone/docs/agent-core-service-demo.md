# Standalone Agent-Core API Demo

The demo runs the harness as a separate Node.js service. It has no frontend and
communicates through JSON HTTP requests, server-sent events, and control
endpoints.

## Run locally

Terminal 1:

```bash
npm install
npm run service
```

Terminal 2:

```bash
npm run demo:client -- "Demonstrate the agent-core service"
```

The default deterministic provider requests `write_file`. The client observes
the `permission.requested` SSE event, approves it through the API, receives the
remaining tool and assistant events, replays the session, and closes it. The
isolated output is written to:

```text
.agent-core-demo/workspace/.agent-core-demo.txt
```

No API key or model usage is required for this mode.

## Live OpenRouter mode

```bash
AGENT_PROVIDER=openrouter \
OPENROUTER_API_KEY=... \
AGENT_MODEL=anthropic/claude-sonnet-4.6 \
npm run service
```

`AGENT_MODEL` is optional and falls back to `OPENROUTER_MODEL`, then to the
adapter default. Model ids are OpenRouter slugs; browse the live catalog at
[openrouter.ai/models](https://openrouter.ai/models) or call
`listOpenRouterModels({ toolCapableOnly: true })`. The selected model must
support tool calling for trajectories that use tools.

`OPENROUTER_APP_URL` and `OPENROUTER_APP_NAME` add OpenRouter app attribution
headers. `OPENROUTER_FALLBACK_MODELS` accepts a comma-separated slug list that
OpenRouter may route to when the primary model is unavailable.

## Service configuration

| Variable                     | Default                        | Purpose                                          |
| ---------------------------- | ------------------------------ | ------------------------------------------------ |
| `AGENT_PROVIDER`             | `demo`                         | `demo`, `openrouter`, or `openai-compatible`     |
| `AGENT_SERVICE_HOST`         | `127.0.0.1`                    | Bind address                                     |
| `AGENT_SERVICE_PORT`         | `8787`                         | HTTP port; `0` selects an available port         |
| `AGENT_SERVICE_KEY`          | unset                          | Optional value required in `x-agent-service-key` |
| `AGENT_WORKSPACE`            | `.agent-core-demo/workspace`   | Tool workspace boundary                          |
| `AGENT_DATA_DIR`             | `.agent-core-demo/data`        | Session and artifact files                       |
| `AGENT_PERMISSION_MODE`      | `default`                      | `default`, `plan`, `bypass`, or `deny`           |
| `AGENT_MODEL`                | adapter default                | OpenRouter model slug override                   |
| `OPENROUTER_API_KEY`         | unset                          | OpenRouter credential                            |
| `OPENROUTER_MODEL`           | adapter default                | Model slug used when `AGENT_MODEL` is unset      |
| `OPENROUTER_BASE_URL`        | `https://openrouter.ai/api/v1` | Gateway base URL                                 |
| `OPENROUTER_APP_URL`         | unset                          | Sent as `HTTP-Referer` attribution               |
| `OPENROUTER_APP_NAME`        | unset                          | Sent as `X-OpenRouter-Title` attribution         |
| `OPENROUTER_FALLBACK_MODELS` | unset                          | Comma-separated fallback slugs                   |
| `MODEL_API_KEY`              | unset                          | Generic OpenAI-compatible API key                |
| `MODEL_BASE_URL`             | unset                          | Generic OpenAI-compatible `/v1` base URL         |

For a remotely reachable service, configure `AGENT_SERVICE_KEY`, terminate TLS
in a trusted proxy, and do not use `bypass` permission mode.

## API sequence

All non-health requests may include:

```text
x-agent-owner: <stable caller identity>
x-agent-service-key: <configured service key>
```

1. `GET /health` checks service and protocol version.
2. `POST /sessions` returns `sessionId` and a secret `controlToken`.
3. `POST /sessions/:id/runs` accepts `{ "prompt", "runId" }` and streams SSE.
4. `POST /sessions/:id/permissions/:requestId` accepts an allow/deny decision.
5. `POST /sessions/:id/interrupt` interrupts active model and tool work.
6. `GET /sessions/:id/events?after=<sequence>` replays buffered events.
7. `POST /sessions/:id/artifacts` and `GET /artifacts/:id` transfer artifacts.
8. `DELETE /sessions/:id` closes the controlled session.

Control endpoints use:

```text
Authorization: Bearer <controlToken>
```

The control token must remain server-side or in another trusted client. It is
different from the optional service key.

## Build and run the compiled service

```bash
npm run build
node dist/service/index.js
```

The package also declares the `agent-harness-service` executable.
