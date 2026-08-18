import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactExtension,
  artifactFilename,
  artifactKind,
} from "../src/services/artifact-formats.js";
import { hydrateRuntimeArtifacts } from "../src/services/response-artifacts.js";

function runtimeResult({ artifact, call }) {
  return hydrateRuntimeArtifacts({
    output: "Done.",
    artifacts: [artifact],
    messages: [{ role: "assistant", content: [{ type: "tool_call", ...call }] }],
  });
}

test("hydrates a JSON artifact produced by the harness", () => {
  const result = runtimeResult({
    artifact: {
      id: "artifact-json",
      contentType: "application/json; charset=utf-8",
      size: 0,
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: {
        presentation: "file",
        kind: "json",
        title: "Config",
        filename: "config.json",
        toolCallId: "call-json",
      },
    },
    call: {
      id: "call-json",
      name: "create_json_artifact",
      input: { title: "Config", filename: "config.json", content: '{"a":1}' },
    },
  });

  assert.equal(result.response.type, "files");
  assert.deepEqual(result.artifacts[0], {
    id: "artifact-json",
    kind: "json",
    contentType: "application/json; charset=utf-8",
    size: 7,
    createdAt: "2026-08-18T00:00:00.000Z",
    filename: "config.json",
    title: "Config",
    content: '{"a":1}',
  });
});

test("hydrates an NDJSON artifact separately from JSON", () => {
  const result = runtimeResult({
    artifact: {
      id: "artifact-ndjson",
      contentType: "application/x-ndjson; charset=utf-8",
      size: 0,
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: {
        presentation: "file",
        kind: "ndjson",
        title: "Events",
        filename: "events.ndjson",
        toolCallId: "call-ndjson",
      },
    },
    call: {
      id: "call-ndjson",
      name: "create_json_artifact",
      input: {
        title: "Events",
        filename: "events.ndjson",
        content: '{"id":1}',
        format: "ndjson",
      },
    },
  });

  assert.equal(result.artifacts[0].kind, "ndjson");
  assert.equal(result.artifacts[0].filename, "events.ndjson");
});

test("a code artifact keeps its language and its language-derived extension", () => {
  const result = runtimeResult({
    artifact: {
      id: "artifact-code",
      contentType: "text/plain; charset=utf-8",
      size: 0,
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: {
        presentation: "file",
        kind: "code",
        language: "go",
        title: "Client",
        filename: "client.go",
        toolCallId: "call-code",
      },
    },
    call: {
      id: "call-code",
      name: "create_code_artifact",
      input: {
        title: "Client",
        filename: "client.go",
        language: "go",
        content: "package main\n",
      },
    },
  });

  assert.equal(result.artifacts[0].kind, "code");
  assert.equal(result.artifacts[0].language, "go");
  // The .go must survive: a fixed extension would have produced client.go.txt.
  assert.equal(result.artifacts[0].filename, "client.go");
  assert.equal(result.artifacts[0].content, "package main\n");
});

test("an unknown code language falls back to plain text rather than dropping the file", () => {
  const result = runtimeResult({
    artifact: {
      id: "artifact-code-2",
      contentType: "text/plain; charset=utf-8",
      size: 0,
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: {
        presentation: "file",
        kind: "code",
        language: "brainfuck",
        title: "Odd",
        filename: "odd",
        toolCallId: "call-code-2",
      },
    },
    call: {
      id: "call-code-2",
      name: "create_code_artifact",
      input: { title: "Odd", filename: "odd", content: "+++" },
    },
  });

  assert.equal(result.artifacts[0].kind, "code");
  assert.equal(result.artifacts[0].language, undefined);
  assert.equal(result.artifacts[0].filename, "odd.txt");
});

test("kind resolution covers the new content types and tool names", () => {
  assert.equal(artifactKind({ contentType: "application/json" }), "json");
  assert.equal(
    artifactKind({ contentType: "application/x-ndjson; charset=utf-8" }),
    "ndjson",
  );
  assert.equal(artifactKind({ toolName: "create_code_artifact" }), "code");
  // text/plain must not resolve to code: every language shares it.
  assert.equal(artifactKind({ contentType: "text/plain" }), null);
});

test("filenames resolve the language extension and reject unknown kinds", () => {
  assert.equal(artifactFilename("main", "code", { language: "java" }), "main.java");
  assert.equal(artifactFilename("data", "ndjson"), "data.ndjson");
  assert.equal(artifactExtension("code", { language: "yaml" }), ".yaml");
  assert.equal(artifactExtension("code"), ".txt");
  assert.equal(artifactFilename("x", "pdf"), null);
});
