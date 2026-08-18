import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackTitle,
  generateChatTitle,
  hasDefaultTitle,
} from "../src/services/chat-title.js";
import { chatUpdateSchema } from "../src/lib/schemas.js";

const provider = {
  provider: "openai-compatible",
  model: "gpt-4o-mini",
  baseURL: "https://models.example.com/v1",
  apiKey: "secret",
};

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function completion(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

test("a prompt-derived title drops code, links and markup", () => {
  assert.equal(
    fallbackTitle("```js\nconst a = 1;\n```\nWhy does this loop never finish?"),
    "Why does this loop never finish",
  );
  assert.equal(
    fallbackTitle("Read https://example.com/spec and summarise it"),
    "Read and summarise it",
  );
  assert.equal(fallbackTitle("## **Deploy** the api"), "Deploy the api");
  assert.equal(fallbackTitle("   "), "New chat");
  assert.equal(fallbackTitle(null), "New chat");
});

test("a prompt-derived title stays short and does not cut a word in half", () => {
  const title = fallbackTitle(
    "Please investigate the intermittent authentication failures affecting " +
      "our production checkout service since yesterday",
  );
  assert.ok(title.length <= 60, title);
  assert.ok(!title.endsWith(" "), title);
  assert.equal(
    title,
    "Please investigate the intermittent authentication failures",
  );
});

test("placeholder titles are recognised and user titles are left alone", () => {
  assert.equal(hasDefaultTitle({ title: "Support bot chat", agentName: "Support bot" }), true);
  assert.equal(hasDefaultTitle({ title: "New chat", agentName: "Support bot" }), true);
  assert.equal(hasDefaultTitle({ title: "", agentName: "Support bot" }), true);
  assert.equal(hasDefaultTitle({ title: "Q3 pricing model", agentName: "Support bot" }), false);
});

test("a generated title is cleaned of quotes, prefixes and trailing punctuation", async () => {
  for (const raw of [
    '  "Title: Debugging the login loop."  ',
    'Title: "Debugging the login loop"',
    "Debugging the login loop.",
    "Debugging the login loop\n\nThat should work.",
  ]) {
    const restore = stubFetch(async () => completion(raw));
    try {
      assert.equal(
        await generateChatTitle({ provider, prompt: "help", reply: "sure" }),
        "Debugging the login loop",
        raw,
      );
    } finally {
      restore();
    }
  }
});

test("the titling request uses the max-tokens field the provider expects", async () => {
  const bodies = [];
  const restore = stubFetch(async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return completion("Pricing questions");
  });
  try {
    await generateChatTitle({ provider, prompt: "help", reply: "" });
    await generateChatTitle({
      provider: { ...provider, provider: "openrouter" },
      prompt: "help",
      reply: "",
    });
    await generateChatTitle({
      provider: { ...provider, wire: { maxTokensField: "max_tokens" } },
      prompt: "help",
      reply: "",
    });
  } finally {
    restore();
  }

  assert.equal(bodies[0].url, "https://models.example.com/v1/chat/completions");
  assert.equal(bodies[0].body.max_completion_tokens, 24);
  // OpenRouter fixes the field, so the stored wire preference is not consulted.
  assert.equal(bodies[1].body.max_tokens, 24);
  assert.equal(bodies[1].body.max_completion_tokens, undefined);
  assert.equal(bodies[2].body.max_tokens, 24);
  assert.equal(bodies[0].body.stream, false);
});

test("a failed, empty or unusable titling call falls back to the prompt", async () => {
  const restoreError = stubFetch(async () => {
    throw new Error("network down");
  });
  try {
    assert.equal(
      await generateChatTitle({ provider, prompt: "Fix the failing build" }),
      "Fix the failing build",
    );
  } finally {
    restoreError();
  }

  const restoreStatus = stubFetch(async () => ({ ok: false, json: async () => ({}) }));
  try {
    assert.equal(
      await generateChatTitle({ provider, prompt: "Fix the failing build" }),
      "Fix the failing build",
    );
  } finally {
    restoreStatus();
  }

  const restoreBlank = stubFetch(async () => completion("   "));
  try {
    assert.equal(
      await generateChatTitle({ provider, prompt: "Fix the failing build" }),
      "Fix the failing build",
    );
  } finally {
    restoreBlank();
  }
});

test("a provider with no credential is never called", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return completion("Should not happen");
  });
  try {
    assert.equal(
      await generateChatTitle({
        provider: { ...provider, apiKey: "" },
        prompt: "Fix the failing build",
      }),
      "Fix the failing build",
    );
    assert.equal(
      await generateChatTitle({ provider: undefined, prompt: "Fix the failing build" }),
      "Fix the failing build",
    );
  } finally {
    restore();
  }
  assert.equal(called, false);
});

test("a chat patch accepts a title, a pin, or both but not nothing", () => {
  assert.equal(chatUpdateSchema.safeParse({ title: "Renamed" }).success, true);
  assert.equal(chatUpdateSchema.safeParse({ pinned: true }).success, true);
  assert.equal(
    chatUpdateSchema.safeParse({ title: "Renamed", pinned: false }).success,
    true,
  );
  assert.equal(chatUpdateSchema.safeParse({}).success, false);
  assert.equal(chatUpdateSchema.safeParse({ title: "" }).success, false);
  assert.equal(chatUpdateSchema.safeParse({ pinned: "yes" }).success, false);
  assert.equal(
    chatUpdateSchema.safeParse({ title: "Renamed", other: 1 }).success,
    false,
  );
});
