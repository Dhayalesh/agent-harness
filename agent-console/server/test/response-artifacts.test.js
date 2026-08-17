import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { Chat } from "../src/models/chat.js";
import { loadArtifactBody } from "../src/services/artifact-content.js";
import { hydrateRuntimeArtifacts } from "../src/services/response-artifacts.js";

const artifact = {
  id: "artifact-1",
  contentType: "text/markdown; charset=utf-8",
  size: 1,
  createdAt: "2026-08-14T00:00:00.000Z",
  metadata: {
    presentation: "file",
    kind: "markdown",
    title: "Launch plan",
    filename: "launch-plan.md",
    toolCallId: "call-doc",
  },
};

test("hydrates a buffered artifact from its Markdown tool call", () => {
  const result = hydrateRuntimeArtifacts({
    output: "I created the document.",
    artifacts: [artifact],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-doc",
            name: "create_markdown_artifact",
            input: {
              title: "Launch plan",
              filename: "launch-plan.md",
              content: "# Launch plan",
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.output, "I created the document.");
  assert.equal(result.response.type, "files");
  assert.deepEqual(result.artifacts[0], {
    id: "artifact-1",
    kind: "markdown",
    contentType: "text/markdown; charset=utf-8",
    size: 13,
    createdAt: "2026-08-14T00:00:00.000Z",
    filename: "launch-plan.md",
    title: "Launch plan",
    content: "# Launch plan",
  });
});

test("hydrates HTML locally and binary office files by S3 reference", () => {
  const html = hydrateRuntimeArtifacts({
    output: "Created the report.",
    artifacts: [
      {
        id: "artifact-html",
        contentType: "text/html; charset=utf-8",
        size: 0,
        createdAt: "2026-08-14T00:00:00.000Z",
        metadata: { kind: "html", toolCallId: "call-html" },
      },
      {
        id: "artifact-docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1024,
        createdAt: "2026-08-14T00:00:00.000Z",
        metadata: {
          kind: "docx",
          title: "Runbook",
          filename: "runbook.docx",
          toolCallId: "call-docx",
        },
        storage: {
          kind: "s3",
          bucket: "private-agent-artifacts",
          key: "artifacts/artifact-docx/content",
        },
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-html",
            name: "create_html_artifact",
            input: {
              title: "Web report",
              filename: "report",
              content: "<h1>Report</h1>",
            },
          },
          {
            type: "tool_call",
            id: "call-docx",
            name: "create_document_artifact",
            input: {
              title: "Runbook",
              filename: "runbook",
              content: "# Runbook",
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(html.artifacts[0], {
    id: "artifact-html",
    kind: "html",
    contentType: "text/html; charset=utf-8",
    size: 15,
    createdAt: "2026-08-14T00:00:00.000Z",
    filename: "report.html",
    title: "Web report",
    content: "<h1>Report</h1>",
  });
  assert.equal(html.artifacts[1].kind, "docx");
  assert.equal(
    html.artifacts[1].storage.key,
    "artifacts/artifact-docx/content",
  );
  assert.equal(Object.hasOwn(html.artifacts[1], "content"), false);
});

test("keeps an S3 reference without copying Markdown from the tool transcript", () => {
  const result = hydrateRuntimeArtifacts({
    output: "I created the document.",
    artifacts: [
      {
        ...artifact,
        size: 13,
        storage: {
          kind: "s3",
          bucket: "private-agent-artifacts",
          key: "production/artifacts/artifact-1.md",
          region: "us-east-1",
          versionId: "version-1",
          checksumSha256: "checksum",
        },
      },
    ],
    messages: [],
  });

  assert.equal(result.output, "I created the document.");
  assert.equal(result.artifacts[0].size, 13);
  assert.equal(Object.hasOwn(result.artifacts[0], "content"), false);
  assert.deepEqual(result.artifacts[0].storage, {
    kind: "s3",
    bucket: "private-agent-artifacts",
    key: "production/artifacts/artifact-1.md",
    region: "us-east-1",
    versionId: "version-1",
    checksumSha256: "checksum",
  });
});

test("chat JSON exposes preview URLs without exposing stored Markdown", () => {
  const chat = new Chat({
    _id: "507f1f77bcf86cd799439011",
    title: "Documentation",
    agentId: "507f1f77bcf86cd799439012",
    agentName: "writer",
    runtimeSessionId: "runtime-session",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "",
        reasoning: "The user requested a Markdown deliverable.",
        createdAt: "2026-08-14T00:00:00.000Z",
        toolCalls: [
          {
            id: "tool-1",
            name: "create_markdown_artifact",
            input: '{"filename":"launch-plan.md"}',
            output: "Saved",
            status: "done",
          },
        ],
        artifacts: [
          {
            id: "artifact-1",
            title: "Launch plan",
            filename: "launch-plan.md",
            contentType: "text/markdown; charset=utf-8",
            size: 13,
            createdAt: "2026-08-14T00:00:00.000Z",
            content: "# Launch plan",
            storage: {
              kind: "s3",
              bucket: "private-agent-artifacts",
              key: "production/artifacts/artifact-1.md",
            },
          },
        ],
      },
    ],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  });

  const json = chat.toJSON();
  const visible = json.messages[0].artifacts[0];
  assert.equal(
    json.messages[0].reasoning,
    "The user requested a Markdown deliverable.",
  );
  assert.deepEqual(json.messages[0].toolCalls, [
    {
      id: "tool-1",
      name: "create_markdown_artifact",
      input: '{"filename":"launch-plan.md"}',
      output: "Saved",
      status: "done",
    },
  ]);
  assert.equal(Object.hasOwn(visible, "content"), false);
  assert.equal(Object.hasOwn(visible, "storage"), false);
  assert.equal(
    visible.url,
    "/api/chats/507f1f77bcf86cd799439011/artifacts/artifact-1",
  );
  assert.equal(visible.downloadUrl, visible.url + "?download=true");
});

test("serves persisted Markdown inline for preview and as a download", async (context) => {
  const chat = new Chat({
    _id: "507f1f77bcf86cd799439011",
    title: "Documentation",
    agentId: "507f1f77bcf86cd799439012",
    agentName: "writer",
    runtimeSessionId: "runtime-session",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "",
        createdAt: "2026-08-14T00:00:00.000Z",
        artifacts: [
          {
            id: "artifact-1",
            title: "Launch plan",
            filename: "launch-plan.md",
            contentType: "text/markdown; charset=utf-8",
            size: 13,
            createdAt: "2026-08-14T00:00:00.000Z",
            content: "# Launch plan",
          },
        ],
      },
    ],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  const originalFindById = Chat.findById;
  Chat.findById = async () => chat;
  context.after(() => {
    Chat.findById = originalFindById;
  });

  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/chats/507f1f77bcf86cd799439011/artifacts/artifact-1`;

  const preview = await fetch(url);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition"), /^inline;/);
  assert.equal(await preview.text(), "# Launch plan");

  const download = await fetch(url + "?download=true");
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
});

test("serves HTML as a sandboxed attachment with a canonical media type", async (context) => {
  const chat = new Chat({
    _id: "507f1f77bcf86cd799439011",
    title: "HTML report",
    agentId: "507f1f77bcf86cd799439012",
    agentName: "writer",
    runtimeSessionId: "runtime-session",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "Created the report.",
        createdAt: "2026-08-14T00:00:00.000Z",
        artifacts: [
          {
            id: "artifact-html",
            kind: "html",
            title: "Report",
            filename: "report.html",
            contentType: "text/html; charset=utf-8",
            size: 25,
            createdAt: "2026-08-14T00:00:00.000Z",
            content: "<script>alert(1)</script>",
          },
        ],
      },
    ],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  const originalFindById = Chat.findById;
  Chat.findById = async () => chat;
  context.after(() => {
    Chat.findById = originalFindById;
  });
  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const { port } = server.address();

  const response = await fetch(
    `http://127.0.0.1:${port}/api/chats/507f1f77bcf86cd799439011/artifacts/artifact-html`,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-security-policy"),
    "sandbox; default-src 'none'",
  );
});

test("loads a referenced Markdown object from the allowlisted S3 bucket", async (context) => {
  const previousBucket = config.artifacts.bucket;
  const previousPrefix = config.artifacts.prefix;
  config.artifacts.bucket = "private-agent-artifacts";
  config.artifacts.prefix = "production/artifacts";
  context.after(() => {
    config.artifacts.bucket = previousBucket;
    config.artifacts.prefix = previousPrefix;
  });
  const commands = [];
  const body = await loadArtifactBody(
    {
      storage: {
        kind: "s3",
        bucket: "private-agent-artifacts",
        key: "production/artifacts/artifact-1.md",
        versionId: "version-1",
        checksumSha256: "checksum",
      },
    },
    {
      client: {
        async send(command) {
          commands.push(command);
          return {
            ContentLength: 13,
            ChecksumSHA256: "checksum",
            Body: {
              async transformToByteArray() {
                return Buffer.from("# Launch plan");
              },
            },
          };
        },
      },
    },
  );

  assert.equal(body.toString("utf8"), "# Launch plan");
  assert.deepEqual(commands[0].input, {
    Bucket: "private-agent-artifacts",
    Key: "production/artifacts/artifact-1.md",
    VersionId: "version-1",
    ChecksumMode: "ENABLED",
  });
});
