import express from "express";
import mongoose from "mongoose";
import { asyncHandler, notFound } from "../lib/http-error.js";
import { Run, runSummaries } from "../models/run.js";

export const runsRouter = express.Router();

runsRouter.get(
  "/",
  asyncHandler(async (request, response) => {
    const filter = {};
    if (request.query.agentId) {
      if (!mongoose.isValidObjectId(request.query.agentId)) {
        return response.json({ runs: [], total: 0 });
      }
      filter.agentId = request.query.agentId;
    }
    if (request.query.chatId) {
      if (!mongoose.isValidObjectId(request.query.chatId)) {
        return response.json({ runs: [], total: 0 });
      }
      filter.chatId = String(request.query.chatId);
    }
    if (request.query.status) filter.status = request.query.status;
    if (request.query.runtimeSessionId) {
      filter.runtimeSessionId = String(request.query.runtimeSessionId);
    }

    const limit = Math.min(
      Math.max(Number.parseInt(request.query.limit ?? "50", 10) || 50, 1),
      200,
    );
    const sortDirection = request.query.sort === "oldest" ? 1 : -1;
    const [runs, total] = await Promise.all([
      runSummaries(filter, limit, sortDirection),
      Run.countDocuments(filter),
    ]);
    response.json({ runs, total });
  }),
);

runsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      throw notFound(`No run with id ${request.params.id}`);
    }
    const run = await Run.findById(request.params.id);
    if (!run) throw notFound(`No run with id ${request.params.id}`);
    response.json({ run });
  }),
);

runsRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      throw notFound(`No run with id ${request.params.id}`);
    }
    const result = await Run.findByIdAndDelete(request.params.id);
    if (!result) throw notFound(`No run with id ${request.params.id}`);
    response.json({ deleted: true, id: request.params.id });
  }),
);
