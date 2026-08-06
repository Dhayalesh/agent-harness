import express from "express";
import { asyncHandler } from "../lib/http-error.js";
import { Agent } from "../models/agent.js";
import { Chat, chatSummaries } from "../models/chat.js";
import { McpServer } from "../models/mcp-server.js";
import { ModelProvider } from "../models/model-provider.js";
import { Run } from "../models/run.js";
import { Skill } from "../models/skill.js";

export const dashboardRouter = express.Router();

dashboardRouter.get("/", asyncHandler(async (_request, response) => {
  const [
    agents,
    modelProviders,
    mcpServers,
    skills,
    chats,
    recentRuns,
    recentChats,
  ] = await Promise.all([
    Agent.countDocuments(),
    ModelProvider.countDocuments(),
    McpServer.countDocuments(),
    Skill.countDocuments(),
    Chat.countDocuments(),
    Run.find()
      .select("-prompt -output")
      .sort({ createdAt: -1 })
      .limit(8),
    chatSummaries({}, 8),
  ]);
  response.json({
    dashboard: {
      counts: { agents, modelProviders, mcpServers, skills, chats },
      recentRuns,
      recentChats,
    },
  });
}));
