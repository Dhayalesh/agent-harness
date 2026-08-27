import express from "express";
import { config } from "../config.js";
import { asyncHandler, conflict } from "../lib/http-error.js";
import {
  parseOrThrow,
  templateCreateSchema,
  templateRecordSchema,
  templateUpdateSchema,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { Template } from "../models/template.js";
import {
  createRecord,
  loadTemplate,
  safeTemplate,
  saveMergedRecord,
} from "../services/platform.js";
import {
  deleteManagedTemplateContent,
  loadTemplateContent,
  storeTemplateContent,
  templateContentUri,
} from "../services/template-content.js";

export const templatesRouter = express.Router();

templatesRouter.get("/", asyncHandler(async (request, response) => {
  const filter = searchFilter(request.query.q);
  if (request.query.enabled === "true") filter.enabled = true;
  if (request.query.enabled === "false") filter.enabled = false;
  const templates = await Template.find(filter).sort({ name: 1 }).limit(200);
  response.json({
    templates: templates.map(safeTemplate),
    total: await Template.countDocuments(filter),
  });
}));

templatesRouter.get("/:id", asyncHandler(async (request, response) => {
  const template = await loadTemplate(request.params.id);
  const content = await loadTemplateContent(
    template.uri,
    `template ${template.name}`,
  );
  response.json({
    template: { ...safeTemplate(template), content },
    referencedByCount: await Agent.countDocuments({
      "templates.templateId": template._id.toString(),
    }),
  });
}));
templatesRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(templateCreateSchema, request.body);
  if (await Template.exists({ name: input.name })) {
    throw conflict(`A template named "${input.name}" already exists`);
  }

  const uri = await storeTemplateContent(input.name, input.content);
  let template;
  try {
    template = await createRecord(Template, {
      name: input.name,
      uri,
      enabled: input.enabled,
      createdBy: config.createdBy,
    });
  } catch (error) {
    await cleanup(uri);
    if (error?.code === 11000) {
      throw conflict(`A template named "${input.name}" already exists`);
    }
    throw error;
  }
  response.status(201).json({ template: safeTemplate(template) });
}));

templatesRouter.patch("/:id", asyncHandler(async (request, response) => {
  const patch = parseOrThrow(templateUpdateSchema, request.body);
  const template = await loadTemplate(request.params.id);
  const { content, ...recordPatch } = patch;
  const previousUri = template.uri;
  const nextName = recordPatch.name ?? template.name;
  const renamed = nextName !== template.name;

  if (
    renamed &&
    await Template.exists({ name: nextName, _id: { $ne: template._id } })
  ) {
    throw conflict(`A template named "${nextName}" already exists`);
  }

  let nextUri;
  if (content !== undefined || renamed) {
    const nextContent =
      content ?? await loadTemplateContent(previousUri, `template ${template.name}`);
    nextUri = templateContentUri(nextName);
    await storeTemplateContent(nextName, nextContent, {
      overwrite: nextUri === previousUri,
    });
    recordPatch.uri = nextUri;
  }

  try {
    await saveMergedRecord(
      template,
      recordPatch,
      templateRecordSchema,
      "Template",
    );
  } catch (error) {
    if (nextUri && nextUri !== previousUri) await cleanup(nextUri);
    if (error?.code === 11000) {
      throw conflict(`A template named "${template.name}" already exists`);
    }
    throw error;
  }

  if (nextUri && previousUri !== nextUri) await cleanup(previousUri);
  response.json({ template: safeTemplate(template) });
}));
templatesRouter.delete("/:id", asyncHandler(async (request, response) => {
  const template = await loadTemplate(request.params.id);
  const referencedByCount = await Agent.countDocuments({
    "templates.templateId": template._id.toString(),
  });
  if (referencedByCount) {
    throw conflict(
      `Cannot delete a template referenced by ${referencedByCount} agent(s).`,
    );
  }
  const uri = template.uri;
  await template.deleteOne();
  await cleanup(uri);
  response.json({ deleted: true, id: request.params.id });
}));

async function cleanup(uri) {
  try {
    await deleteManagedTemplateContent(uri);
  } catch (error) {
    process.stderr.write(
      `agent-console: unable to clean up managed template object: ${error?.message ?? error}\n`,
    );
  }
}

function searchFilter(query) {
  if (!query) return {};
  const safe = String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { name: { $regex: safe, $options: "i" } };
}
