import assert from "node:assert/strict";
import test from "node:test";
import { redactPayload } from "../src/services/payload.js";

test("recursively redacts credentials, headers, and environment values", () => {
  const payload = {
    modelProvider: {
      apiKey: "provider-secret",
      auth: {
        accessToken: "access-token",
        refresh_token: "refresh-token",
      },
      headers: {
        Authorization: "Bearer provider-secret",
        "X-OpenRouter-Title": "Agent Console",
      },
    },
    mcpServers: [
      {
        api_key: "mcp-secret",
        env: {
          DATABASE_URL: "mongodb://user:password@example.test/db",
          PUBLIC_MODE: "production",
        },
        nested: {
          password: "nested-password",
          clientSecret: "nested-secret",
          tokenCount: 7,
        },
      },
    ],
    harmless: {
      monkey: "visible",
      tokenCount: 3,
    },
  };

  const redacted = redactPayload(payload);

  assert.equal(redacted.modelProvider.apiKey, "***redacted***");
  assert.equal(redacted.modelProvider.auth.accessToken, "***redacted***");
  assert.equal(redacted.modelProvider.auth.refresh_token, "***redacted***");
  assert.deepEqual(redacted.modelProvider.headers, {
    Authorization: "***redacted***",
    "X-OpenRouter-Title": "***redacted***",
  });
  assert.equal(redacted.mcpServers[0].api_key, "***redacted***");
  assert.deepEqual(redacted.mcpServers[0].env, {
    DATABASE_URL: "***redacted***",
    PUBLIC_MODE: "***redacted***",
  });
  assert.equal(redacted.mcpServers[0].nested.password, "***redacted***");
  assert.equal(redacted.mcpServers[0].nested.clientSecret, "***redacted***");
  assert.equal(redacted.mcpServers[0].nested.tokenCount, 7);
  assert.deepEqual(redacted.harmless, { monkey: "visible", tokenCount: 3 });

  assert.equal(payload.modelProvider.apiKey, "provider-secret");
  assert.equal(payload.mcpServers[0].env.PUBLIC_MODE, "production");
});

test("preserves absent credentials while redacting populated values in arrays", () => {
  assert.deepEqual(
    redactPayload([
      { apiKey: "", secret: null, password: undefined },
      { token: "set", value: "visible" },
    ]),
    [
      { apiKey: "", secret: null, password: undefined },
      { token: "***redacted***", value: "visible" },
    ],
  );
});
