import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";

test("returns JSON 400 and 413 errors for invalid request bodies", async (context) => {
  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const endpoint = "http://127.0.0.1:" + port + "/api/agents";

  const malformed = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: "Request body is not valid JSON",
  });

  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(5 * 1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: "Request body exceeds the 5 MB limit",
  });
});
