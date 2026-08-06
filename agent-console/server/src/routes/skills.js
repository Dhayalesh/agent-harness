import express from "express";
import { config } from "../config.js";
import { asyncHandler, conflict } from "../lib/http-error.js";
import {
  parseOrThrow,
  skillCreateSchema,
  skillRecordSchema,
  skillUpdateSchema,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { Skill } from "../models/skill.js";
import {
  createRecord,
  loadSkill,
  safeSkill,
  saveMergedRecord,
} from "../services/platform.js";
import { parseS3Uri } from "../services/skill-content.js";

export const skillsRouter = express.Router();

skillsRouter.get("/", asyncHandler(async (request, response) => {
  const filter = searchFilter(request.query.q);
  if (request.query.enabled === "true") filter.enabled = true;
  if (request.query.enabled === "false") filter.enabled = false;
  const skills = await Skill.find(filter).sort({ name: 1 }).limit(200);
  response.json({
    skills: skills.map(safeSkill),
    total: await Skill.countDocuments(filter),
  });
}));

skillsRouter.get("/:id", asyncHandler(async (request, response) => {
  const skill = await loadSkill(request.params.id);
  response.json({
    skill: safeSkill(skill),
    referencedByCount: await Agent.countDocuments({
      "skills.skillId": skill._id.toString(),
    }),
  });
}));

skillsRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(skillCreateSchema, request.body);
  parseS3Uri(input.uri, "skill " + input.name);
  let skill;
  try {
    skill = await createRecord(Skill, { ...input, createdBy: config.createdBy });
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('A skill named "' + input.name + '" already exists');
    }
    throw error;
  }
  response.status(201).json({ skill: safeSkill(skill) });
}));

skillsRouter.patch("/:id", asyncHandler(async (request, response) => {
  const patch = parseOrThrow(skillUpdateSchema, request.body);
  const skill = await loadSkill(request.params.id);
  if (patch.uri) parseS3Uri(patch.uri, "skill " + (patch.name ?? skill.name));
  try {
    await saveMergedRecord(skill, patch, skillRecordSchema, "Skill");
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('A skill named "' + skill.name + '" already exists');
    }
    throw error;
  }
  response.json({ skill: safeSkill(skill) });
}));

skillsRouter.delete("/:id", asyncHandler(async (request, response) => {
  const skill = await loadSkill(request.params.id);
  const referencedByCount = await Agent.countDocuments({
    "skills.skillId": skill._id.toString(),
  });
  if (referencedByCount) {
    throw conflict(
      "Cannot delete a skill referenced by " + referencedByCount + " agent(s).",
    );
  }
  await skill.deleteOne();
  response.json({ deleted: true, id: request.params.id });
}));

function searchFilter(query) {
  if (!query) return {};
  return { name: { $regex: escapeSearch(query), $options: "i" } };
}

function escapeSearch(value) {
  return [...String(value).slice(0, 100)]
    .map((character) =>
      ".*+?^$()|[]{}".includes(character) || character.charCodeAt(0) === 92
        ? String.fromCharCode(92) + character
        : character,
    )
    .join("");
}
