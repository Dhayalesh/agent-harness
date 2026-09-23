// Real local Laya + real harness HTTP transport. Cloud/model/storage are fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  routeSkills,
  skillDecisionBackend,
} from "../src/services/skill-routing.js";
import { decisionConfig } from "../src/services/decisions/config.js";
import { invokeAgentRuntime } from "../src/services/agentcore.js";
import {
  InMemoryContentStore,
  InMemorySessionStore,
  startHeadlessServer,
} from "../../../agent-harness-clone/dist/index.js";

const settings = decisionConfig({ ...process.env, SKILL_ROUTING_MODE: "laya" });
const skills = [
  [
    "aws",
    "Query Amazon AWS EC2 instances, running servers, regions and infrastructure inventory.",
  ],
  [
    "excel",
    "Create or export Excel spreadsheets and XLSX workbooks from data.",
  ],
  ["email", "Compose and send email messages to recipients."],
].map(([name, routingDescription]) => ({
  document: { _id: name },
  value: {
    name,
    routingDescription,
    enabled: true,
    uri: `s3://smoke-skills/${name}`,
  },
}));
const requests = [];
const endpoint = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    'data: {"choices":[{"delta":{"content":"Local invocation completed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
const loaded = [];
class ObservedStore extends InMemoryContentStore {
  async load(key) {
    loaded.push(key);
    return super.load(key);
  }
}
let harness;
try {
  harness = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    serviceKey: "smoke-only",
    sessionStore: new InMemorySessionStore(),
    skillContentStore: new ObservedStore(
      Object.fromEntries(
        skills.map(({ value }) => [
          value.name,
          `---\nname: ${value.name}\ndescription: ${value.routingDescription}\n---\nFixture instructions for ${value.name}.`,
        ]),
      ),
    ),
  });
  for (const [prompt, expected, history] of [
    [
      "Get all running AWS EC2 servers and put them in an Excel file",
      ["aws", "excel"],
      [],
    ],
    ["Hello, how are you?", [], []],
    ["What is two plus two?", [], []],
    ["Write an email to my manager", ["email"], []],
    [
      "Write an email to my manager",
      ["email"],
      [{ role: "user", content: "List my running EC2 instances" }],
    ],
    [
      "Show only those in the Mumbai AWS region",
      ["aws"],
      [{ role: "user", content: "List my running EC2 instances" }],
    ],
  ]) {
    const result = await routeSkills(
      { skills, prompt, sessionHistory: history },
      { settings },
    );
    console.log(JSON.stringify({ prompt, ...result.decision }));
    assert.deepEqual(
      result.skills.map((skill) => skill.value.name),
      expected,
    );
    loaded.length = 0;
    const payload = {
      prompt,
      agent: {
        name: "routing-smoke",
        systemPrompt: "Answer briefly.",
        tools: [],
        limits: { maxTurns: 2 },
      },
      modelProvider: {
        provider: "openai-compatible",
        model: "fixture",
        apiKey: "fixture",
        baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`,
      },
      skills: result.skills.map(({ value }) => ({
        name: value.name,
        uri: value.uri,
      })),
      permissionRules: [{ tool: "skill", decision: "allow" }],
      permissionFallback: "deny",
    };
    const invocation = await invokeAgentRuntime({
      runtime: { local: true, url: harness.url, serviceKey: "smoke-only" },
      payload,
      runtimeSessionId: "routing-smoke-" + "a".repeat(36),
    });
    assert.equal(invocation.result.status, "success");
    assert.deepEqual(
      loaded,
      expected,
      "only selected skill bodies may be loaded",
    );
    const skillTool = requests
      .at(-1)
      .tools?.find((tool) => tool.function.name === "skill");
    assert.equal(Boolean(skillTool), expected.length > 0);
  }
  console.log("PASS: real Laya selection and local harness invocation");
} finally {
  await skillDecisionBackend.close();
  await harness?.close();
  endpoint.close();
}
