import express from "express";
import { AVAILABLE_TOOLS, READ_ONLY_TOOLS } from "../config.js";
import { asyncHandler } from "../lib/http-error.js";
import { McpServer } from "../models/mcp-server.js";
import { ModelProvider } from "../models/model-provider.js";
import { Skill } from "../models/skill.js";
import {
  safeMcpServer,
  safeModelProvider,
  safeSkill,
} from "../services/platform.js";

export const catalogueRouter = express.Router();

catalogueRouter.get("/", asyncHandler(async (_request, response) => {
  const [providers, servers, skills] = await Promise.all([
    ModelProvider.find({ enabled: true }).select("+apiKey +headers").sort({ name: 1 }),
    McpServer.find({ enabled: true })
      .select("+apiKey +env +headers")
      .sort({ name: 1 }),
    Skill.find({ enabled: true }).sort({ name: 1 }),
  ]);
  response.json({
    tools: AVAILABLE_TOOLS.map((name) => ({
      name,
      readOnly: READ_ONLY_TOOLS.includes(name),
    })),
    modelProviders: providers.map(safeModelProvider),
    mcpServers: servers.map(safeMcpServer),
    skills: skills.map(safeSkill),
  });
}));
