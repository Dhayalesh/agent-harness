import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("invokes AgentCore with the harness payload and reads the buffered result", async () => {
  const previous = {
    endpoint: process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  };

  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";

  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      method: request.method,
      url: request.url,
      sessionId: request.headers["x-amzn-bedrock-agentcore-runtime-session-id"],
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "success",
        sessionId: received.sessionId,
        agentName: "reviewer",
        session: {
          mode: "persistent",
          storage: "s3",
          resumed: false,
          origin: "new",
          historyMessageCount: 2,
        },
        output: "done",
        messages: [],
        workingDirectory: "/tmp/work",
        turns: 1,
        usage: { inputTokens: 4, outputTokens: 2 },
        tools: [],
        durationMs: 10,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE =
      "http://127.0.0.1:" + address.port;
    const { invokeAgentRuntime } = await import("../src/services/agentcore.js");
    const runtimeSessionId = "a".repeat(36);
    const payload = { prompt: "hello" };
    const invocation = await invokeAgentRuntime({
      runtime: {
        arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime",
        region: "us-west-2",
      },
      payload,
      runtimeSessionId,
    });

    assert.equal(invocation.result.output, "done");
    assert.equal(invocation.runtimeSessionId, runtimeSessionId);
    assert.equal(received.method, "POST");
    assert.equal(received.sessionId, runtimeSessionId);
    assert.deepEqual(received.body, payload);
    assert.match(received.authorization, /^AWS4-HMAC-SHA256 /);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", previous.endpoint);
    restore("AWS_ACCESS_KEY_ID", previous.accessKey);
    restore("AWS_SECRET_ACCESS_KEY", previous.secretKey);
  }
});

test("uses each runtime ARN region unless an explicit region override is set", async () => {
  const { config } = await import("../src/config.js");
  const { resolveRuntime } = await import("../src/services/agentcore.js");
  const previous = config.agentcore.regionOverride;
  try {
    config.agentcore.regionOverride = "";
    assert.equal(
      resolveRuntime({
        name: "reviewer",
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test-runtime",
      }).region,
      "eu-west-1",
    );

    config.agentcore.regionOverride = "ap-south-1";
    assert.equal(
      resolveRuntime({
        name: "reviewer",
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test-runtime",
      }).region,
      "ap-south-1",
    );
  } finally {
    config.agentcore.regionOverride = previous;
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
