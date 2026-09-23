# Skill decision layer

The console classifies each user turn before building either a local HTTP or
AgentCore payload. Only selected skill references reach the harness; only those
bodies are downloaded. The existing `skill` tool still controls when instructions
enter model context. Agent, model, MCP and template selection are unchanged.

## Local setup

1. Install the console server dependencies with `npm ci` (optional dependencies
   must be included for Laya). The backend is pinned to `@receptron/laya@0.1.2`.
2. Provision a trusted ONNX bundle containing `laya.onnx`, `laya.onnx.data`,
   `laya_config.json`, `tokenizer/tokenizer.json`, and
   `tokenizer/tokenizer_config.json`. Weights are not committed or downloaded on
   requests. Record the artifact revision/checksum in your deployment system.
3. In the Skills editor, add a concise **When to use this skill** description to
   every enabled skill assigned to the agent. Include intended tasks and useful
   exclusions. Older records remain valid with routing off; routing on refuses
   missing descriptions instead of guessing from names. Update descriptions when
   changing instructions. Do not put credentials in descriptions.
4. Configure `agent-console/server/.env`:

   ```dotenv
   LOCAL_HARNESS_URL=http://127.0.0.1:8080
   SKILL_ROUTING_MODE=laya
   LAYA_MODEL_DIR=/absolute/path/to/onnx-bundle
   LAYA_THREADS=2
   LAYA_TIMEOUT_MS=30000
   SKILL_ROUTING_THRESHOLD=0.75
   SKILL_ROUTING_MAX_SKILLS=5
   SKILL_ROUTING_FAILURE=error
   ```

5. Build and start the harness from `agent-harness-clone`:

   ```sh
   npm run build
   node --env-file-if-exists=.env dist/headless/main.js
   ```

   Start the console with its existing `npm run dev` workflow. Match
   `LOCAL_HARNESS_SERVICE_KEY` to `AGENT_SERVICE_KEY` when configured. Existing
   MongoDB, S3 skill storage, model and MCP configuration are still required for
   real conversations.

## Behavior and operational limits

- `off` is the default and preserves the existing all-assigned-skills behavior.
- The reusable decision API accepts purpose, state, dynamic options, single or
  multiple selection, threshold and selection limit. Only skills use it in this MVP.
- Each candidate is evaluated independently. Multiple selections do not compete
  for one winning label. Unknown, duplicate, non-finite or missing scores fail
  validation. Selected references retain assignment order and allowed tools.
- Disabled skills are excluded when routing is on. Missing assigned records still
  fail configuration validation.
- A successful empty selection is `no_match`. Backend errors are `error`, with
  a sanitized code. `SKILL_ROUTING_FAILURE=error` returns HTTP 503 (or the normal
  console failure event after SSE headers). `none` explicitly continues with no
  skills and records the failure. There is no implicit load-all fallback.
- More matches than the configured maximum is an explicit error. Dependencies
  are not inferred or expanded by this MVP; author descriptions accordingly and
  validate compound tasks before rollout.
- Routing uses the latest prompt, up to five attachment names/types, and the two
  most recent history entries when the prompt has an explicit English follow-up
  reference (for example, "those", "it", "previous", or "continue"). Self-contained
  requests exclude history so an old topic does not dominate. This conservative
  heuristic can miss implicit follow-ups; include the subject in those requests.
  It does not receive credentials, file bytes, or
  skill bodies. Inputs are bounded and character truncation is reported. The
  English checkpoint additionally truncates at its own 512-token context limit;
  long and multilingual requests require evaluation before rollout.
- One resident worker/model per console process, one active decision at a time.
  Concurrent decisions fail with `CAPACITY` under the configured fallback policy.
  No unbounded inference queue. Timeout or cancellation terminates the worker;
  the next request reloads it. Budget several GB RAM per console replica.
- Routing is per turn, not once per conversation. Follow-ups include recent
  context; topic changes may change the selected set. Classification does not
  grant permissions or invoke AWS by itself.
- Compaction requests skip routing and offer no new skills. Historical skill
  tool results may remain in persisted model history or compaction summaries.
  Filtering the current catalogue does not revoke historical instructions.
- This MVP caches the loaded **classifier model**, not S3 skill bodies or decision
  results. Selected skill documents are still downloaded on each invocation.
  Version-aware skill caching is separate work; no stale-body cache is introduced.

## Observability and verification

Agent preview responses expose `skillRouting`; successful invocations and
continue-with-none failures store it on the Run. It contains selected IDs,
candidate scores, duration and status, without prompts or credentials. A routing
failure that prevents invocation is logged as `skills.routing.failed` and returned
through the existing chat failure path; no runtime Run is created in that case.

From `agent-console/server`:

```sh
node --test test/skill-routing.test.js test/payload.test.js
LAYA_MODEL_DIR=/absolute/path/to/onnx-bundle node scripts/skill-routing-smoke.mjs
```

The smoke test requires a built sibling harness. It uses real Laya weights and
real loopback harness HTTP invocation, with an in-memory skill store and scripted
model server. It asserts only selected skill bodies are fetched. It does not test
live MongoDB, S3, EC2, or deployed AgentCore. Thresholds require evaluation on your
actual catalogue: scores are not an accuracy guarantee.

## AgentCore rollout

Routing runs in the **console server**, before transport choice. Deploy that
server with its optional Laya dependency and a provisioned model directory. Keep
weights outside Git and provide sufficient memory for each replica. The existing
ARM64 harness image does not need ONNX or Laya weights for this architecture.

After local validation, unset `LOCAL_HARNESS_URL` and configure the existing
`AGENTCORE_RUNTIME_ARN`, region and IAM credentials. The filtered payload contract
is unchanged, so it works with the current AgentCore runtime. Keep the existing
runtime role's S3 access to selected skill objects. Direct callers that bypass the
console also bypass routing; they must provide their own selected skill list.

Deploying only the harness image will not enable the decision layer. Roll back
selection by setting `SKILL_ROUTING_MODE=off` on the console and restarting it.
