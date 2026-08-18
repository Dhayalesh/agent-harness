import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";

/**
 * The multipart parser runs as middleware ahead of the route handler, so its limits
 * are observable without a database behind the route. That makes these the only
 * upload behaviours worth asserting at the HTTP level here.
 */
async function withServer(context) {
  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

const CHAT = "/api/chats/6890f4c2b1a4c3d2e1f00001/attachments";

test("a file over the size limit is refused with the limit named", async (context) => {
  const base = await withServer(context);
  const form = new FormData();
  form.append(
    "files",
    new Blob(["x".repeat(config.uploads.maxFileBytes + 1024)]),
    "big.txt",
  );

  const response = await fetch(base + CHAT, { method: "POST", body: form });
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.match(payload.error, /upload limit/);
  // Actionable without reading the source: the ceiling is in the message.
  assert.match(payload.error, /\d+ MB/);
});

test("more files than the per-request limit is refused with the count", async (context) => {
  const base = await withServer(context);
  const form = new FormData();
  for (let index = 0; index <= config.uploads.maxFiles; index += 1) {
    form.append("files", new Blob(["hello"]), `note-${index}.txt`);
  }

  const response = await fetch(base + CHAT, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.match(
    (await response.json()).error,
    new RegExp(`at most ${config.uploads.maxFiles} files`),
  );
});

test("a field name other than files is refused rather than ignored", async (context) => {
  const base = await withServer(context);
  const form = new FormData();
  form.append("attachment", new Blob(["hello"]), "note.txt");

  const response = await fetch(base + CHAT, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Upload rejected/);
});
