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
import {
  deleteManagedSkillContent,
  loadSkillContent,
  skillContentUri,
  storeSkillContent,
} from "../services/skill-content.js";

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
  const content = await loadSkillContent(skill.uri, `skill ${skill.name}`);
  response.json({
    skill: { ...safeSkill(skill), content },
    referencedByCount: await Agent.countDocuments({
      "skills.skillId": skill._id.toString(),
    }),
  });
}));

skillsRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(skillCreateSchema, request.body);
  if (await Skill.exists({ name: input.name })) {
    throw conflict('A skill named "' + input.name + '" already exists');
  }

  const uri = await storeSkillContent(input.name, input.content);
  let skill;
  try {
    skill = await createRecord(Skill, {
      name: input.name,
      uri,
      enabled: input.enabled,
      createdBy: config.createdBy,
    });
  } catch (error) {
    await cleanup(uri);
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
  const { content, ...recordPatch } = patch;
  const previousUri = skill.uri;
  const nextName = recordPatch.name ?? skill.name;
  const renamed = nextName !== skill.name;

  if (
    renamed &&
    await Skill.exists({ name: nextName, _id: { $ne: skill._id } })
  ) {
    throw conflict('A skill named "' + nextName + '" already exists');
  }

  let nextUri;
  if (content !== undefined || renamed) {
    const nextContent =
      content ?? await loadSkillContent(previousUri, `skill ${skill.name}`);
    nextUri = skillContentUri(nextName);
    await storeSkillContent(nextName, nextContent, {
      overwrite: nextUri === previousUri,
    });
    recordPatch.uri = nextUri;
  }

  try {
    await saveMergedRecord(skill, recordPatch, skillRecordSchema, "Skill");
  } catch (error) {
    if (nextUri && nextUri !== previousUri) await cleanup(nextUri);
    if (error?.code === 11000) {
      throw conflict('A skill named "' + skill.name + '" already exists');
    }
    throw error;
  }

  if (nextUri && previousUri !== nextUri) await cleanup(previousUri);
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
  const uri = skill.uri;
  await skill.deleteOne();
  await cleanup(uri);
  response.json({ deleted: true, id: request.params.id });
}));

async function cleanup(uri) {
  try {
    await deleteManagedSkillContent(uri);
  } catch (error) {
    process.stderr.write(
      `agent-console: unable to clean up managed skill object: ${error?.message ?? error}\n`,
    );
  }
}

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
