import express from "express";
import { config } from "../config.js";
import { asyncHandler, conflict } from "../lib/http-error.js";
import {
  mcpServerCreateSchema,
  mcpServerRecordSchema,
  mcpServerUpdateSchema,
  parseOrThrow,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { McpServer } from "../models/mcp-server.js";
import {
  createRecord,
  loadMcpServer,
  safeMcpServer,
  saveMergedRecord,
} from "../services/platform.js";

export const mcpServersRouter = express.Router();

mcpServersRouter.get("/", asyncHandler(async (request, response) => {
  const filter = searchFilter(request.query.q);
  if (request.query.enabled === "true") filter.enabled = true;
  if (request.query.enabled === "false") filter.enabled = false;
  const mcpServers = await McpServer.find(filter)
    .select("+apiKey +env +headers")
    .sort({ name: 1 })
    .limit(200);
  response.json({
    mcpServers: mcpServers.map(safeMcpServer),
    total: await McpServer.countDocuments(filter),
  });
}));

mcpServersRouter.get("/:id", asyncHandler(async (request, response) => {
  const mcpServer = await loadMcpServer(request.params.id, {
    withSecrets: true,
  });
  response.json({
    mcpServer: safeMcpServer(mcpServer),
    referencedByCount: await Agent.countDocuments({
      mcpServerIds: mcpServer._id.toString(),
    }),
  });
}));

mcpServersRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(mcpServerCreateSchema, request.body);
  let mcpServer;
  try {
    mcpServer = await createRecord(McpServer, {
      ...input,
      createdBy: config.createdBy,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('An MCP server named "' + input.name + '" already exists');
    }
    throw error;
  }
  response.status(201).json({ mcpServer: safeMcpServer(mcpServer) });
}));

mcpServersRouter.patch("/:id", asyncHandler(async (request, response) => {
  const patch = parseOrThrow(mcpServerUpdateSchema, request.body);
  const mcpServer = await loadMcpServer(request.params.id, {
    withSecrets: true,
  });
  try {
    await saveMergedRecord(
      mcpServer,
      patch,
      mcpServerRecordSchema,
      "MCP server",
      { secretStrings: ["apiKey"], secretMaps: ["env", "headers"] },
    );
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('An MCP server named "' + mcpServer.name + '" already exists');
    }
    throw error;
  }
  response.json({ mcpServer: safeMcpServer(mcpServer) });
}));

mcpServersRouter.delete("/:id", asyncHandler(async (request, response) => {
  const mcpServer = await loadMcpServer(request.params.id);
  const referencedByCount = await Agent.countDocuments({
    mcpServerIds: mcpServer._id.toString(),
  });
  if (referencedByCount) {
    throw conflict(
      "Cannot delete an MCP server referenced by " +
        referencedByCount +
        " agent(s).",
    );
  }
  await mcpServer.deleteOne();
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
