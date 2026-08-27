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

test("resolveRuntime prefers a configured local harness over any AgentCore ARN", async () => {
  const { config } = await import("../src/config.js");
  const { resolveRuntime } = await import("../src/services/agentcore.js");
  const previous = { ...config.localHarness };
  try {
    config.localHarness.url = "http://127.0.0.1:9999";
    config.localHarness.serviceKey = "";
    const runtime = resolveRuntime({
      name: "reviewer",
      agentRuntimeArn:
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime",
    });
    assert.equal(runtime.local, true);
    assert.equal(runtime.url, "http://127.0.0.1:9999");
  } finally {
    Object.assign(config.localHarness, previous);
  }
});

test("invokeAgentRuntime posts the same payload to a local harness's /invocations", async () => {
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      method: request.method,
      url: request.url,
      accept: request.headers.accept,
      serviceKey: request.headers["x-agent-service-key"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "success",
        sessionId: received.body.sessionId,
        agentName: "reviewer",
        session: {
          mode: "persistent",
          storage: "s3",
          resumed: false,
          origin: "new",
          historyMessageCount: 2,
        },
        output: "done locally",
        messages: [],
        workingDirectory: "/tmp/work",
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        tools: [],
        durationMs: 5,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const { invokeAgentRuntime } = await import("../src/services/agentcore.js");
    const runtimeSessionId = "b".repeat(36);
    const payload = { prompt: "hello", sessionId: runtimeSessionId };
    const invocation = await invokeAgentRuntime({
      runtime: {
        local: true,
        url: "http://127.0.0.1:" + address.port,
        serviceKey: "test-service-key",
      },
      payload,
      runtimeSessionId,
    });

    assert.equal(invocation.result.output, "done locally");
    assert.equal(invocation.runtimeSessionId, runtimeSessionId);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/invocations");
    assert.equal(received.accept, "application/json");
    assert.equal(received.serviceKey, "test-service-key");
    assert.deepEqual(received.body, payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invokeAgentRuntime against a local harness that is not running names the fix", async () => {
  const { invokeAgentRuntime } = await import("../src/services/agentcore.js");
  await assert.rejects(
    invokeAgentRuntime({
      runtime: { local: true, url: "http://127.0.0.1:1" },
      payload: { prompt: "hello" },
      runtimeSessionId: "c".repeat(36),
    }),
    (error) => {
      assert.match(error.message, /Could not reach the local harness/);
      return true;
    },
  );
});

test("checkAgentcore reports local harness readiness from /ping when configured", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/ping") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { config } = await import("../src/config.js");
  const { checkAgentcore } = await import("../src/services/agentcore.js");
  const previous = { ...config.localHarness };
  try {
    const address = server.address();
    config.localHarness.url = "http://127.0.0.1:" + address.port;
    const health = await checkAgentcore();
    assert.equal(health.ready, true);
    assert.equal(health.runtimeArnConfigured, true);
    assert.equal(health.mode, "local");
  } finally {
    Object.assign(config.localHarness, previous);
    await new Promise((resolve) => server.close(resolve));
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
