import assert from "node:assert/strict";
import test from "node:test";
import { routeSkills } from "../src/services/skill-routing.js";
import { decide } from "../src/services/decisions/service.js";
import { decisionConfig } from "../src/services/decisions/config.js";

const settings = {
  mode: "laya",
  threshold: 0.75,
  maxSelections: 5,
  fallback: "error",
};
const skills = ["aws", "excel", "email"].map((name) => ({
  document: { _id: name },
  value: { name, enabled: true, routingDescription: `Tasks for ${name}` },
  allowedTools: ["read_file"],
}));
const backendFor = (values) => ({
  score: async () =>
    skills.map((skill, i) => ({ id: skill.value.name, score: values[i] })),
});

test("compound requests select multiple assigned skills and preserve restrictions/order", async () => {
  const result = await routeSkills(
    { skills, prompt: "EC2 inventory in Excel" },
    {
      settings,
      backend: backendFor([0.9, 0.99, 0.1]),
    },
  );
  assert.deepEqual(result.skills, skills.slice(0, 2));
  assert.equal(result.decision.status, "selected");
});

test("unrelated requests return no_match without forcing a winner", async () => {
  const result = await routeSkills(
    { skills, prompt: "hello" },
    { settings, backend: backendFor([0.1, 0.2, 0.3]) },
  );
  assert.deepEqual(result.skills, []);
  assert.equal(result.decision.status, "no_match");
});

test("follow-up and attachment routing sends bounded metadata, never file contents or credentials", async () => {
  await routeSkills(
    {
      skills,
      prompt: "Export those",
      sessionHistory: [{ role: "user", content: "List EC2 instances" }],
      attachments: [
        {
          filename: "inventory.csv",
          contentType: "text/csv",
          data: "secret-file-bytes",
        },
      ],
    },
    {
      settings,
      backend: {
        score: async (request) => {
          assert.match(request.state, /Previous user: List EC2 instances/);
          assert.match(request.state, /Attachment: inventory.csv/);
          assert.equal(
            JSON.stringify(request).includes("secret-file-bytes"),
            false,
          );
          return backendFor([0.1, 0.9, 0.1]).score();
        },
      },
    },
  );
});

test("disabled routing preserves legacy behavior without calling backend", async () => {
  const result = await routeSkills(
    { skills },
    { settings: { mode: "off" }, backend: {} },
  );
  assert.equal(result.skills, skills);
  assert.equal(result.decision.status, "disabled");
});

test("self-contained topic changes exclude previous task context", async () => {
  const result = await routeSkills(
    {
      skills,
      prompt: "Write an email",
      sessionHistory: [{ role: "user", content: "List EC2 instances" }],
    },
    {
      settings,
      backend: {
        score: async (request) => {
          assert.equal(request.state, "Write an email");
          return backendFor([0.1, 0.1, 0.9]).score();
        },
      },
    },
  );
  assert.equal(result.decision.contextUsed, false);
  assert.deepEqual(result.skills, [skills[2]]);
});

test("empty, disabled-only catalogues and compaction skip inference", async () => {
  for (const input of [
    { skills: [] },
    {
      skills: skills.map((s) => ({
        ...s,
        value: { ...s.value, enabled: false },
      })),
    },
    { skills, operation: "compact" },
  ]) {
    const result = await routeSkills(input, { settings, backend: {} });
    assert.deepEqual(result.skills, []);
  }
});

test("missing descriptions fail explicitly without reading skill bodies", async () => {
  await assert.rejects(
    routeSkills(
      { skills: [{ document: { _id: "a" }, value: { enabled: true } }] },
      { settings, backend: {} },
    ),
    /MISSING_DESCRIPTION/,
  );
});

test("errors differ from no_match and never fall back to loading every skill", async () => {
  const backend = {
    score: async () => {
      throw new Error("TIMEOUT");
    },
  };
  await assert.rejects(
    routeSkills({ skills }, { settings, backend }),
    /TIMEOUT/,
  );
  const result = await routeSkills(
    { skills },
    { settings: { ...settings, fallback: "none" }, backend },
  );
  assert.equal(result.decision.status, "error");
  assert.equal(result.decision.code, "TIMEOUT");
  assert.deepEqual(result.skills, []);
});

test("overflow is explicit instead of silently discarding required skills", async () => {
  await assert.rejects(
    routeSkills(
      { skills },
      {
        settings: { ...settings, maxSelections: 1 },
        backend: backendFor([0.9, 0.9, 0.1]),
      },
    ),
    /TOO_MANY_MATCHES/,
  );
});

test("decision policy rejects unknown, duplicate, missing and invalid scores", async () => {
  const request = {
    options: [{ id: "a" }, { id: "b" }],
    threshold: 0.75,
    maxSelections: 2,
  };
  for (const scores of [
    [
      { id: "a", score: 0.9 },
      { id: "unknown", score: 0.9 },
    ],
    [
      { id: "a", score: 0.9 },
      { id: "a", score: 0.9 },
    ],
    [{ id: "a", score: 0.9 }],
    [
      { id: "a", score: 0.9 },
      { id: "b", score: NaN },
    ],
    [
      { id: "a", score: 0.9 },
      { id: "b", score: 1.1 },
    ],
  ])
    await assert.rejects(
      decide(request, { backend: { score: async () => scores } }),
      /INVALID_SCORES/,
    );
});

test("routing configuration rejects invalid enum, threshold, count and relative model paths", () => {
  assert.equal(decisionConfig({}).mode, "off");
  for (const env of [
    { SKILL_ROUTING_MODE: "maybe" },
    { SKILL_ROUTING_FAILURE: "all" },
    { SKILL_ROUTING_THRESHOLD: "NaN" },
    { SKILL_ROUTING_MAX_SKILLS: "2.5" },
    { SKILL_ROUTING_MODE: "laya", LAYA_MODEL_DIR: "relative" },
  ]) {
    assert.throws(() => decisionConfig(env));
  }
});
