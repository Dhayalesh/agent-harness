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

/**
 * The trace tree for one run: spans built by TraceBuilder at invocation time
 * (services/trace-builder.js), stored on the run rather than in a separate
 * collection for now — see docs/observability-platform-plan.md §6.
 */
runsRouter.get(
  "/:id/trace",
  asyncHandler(async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      throw notFound(`No run with id ${request.params.id}`);
    }
    const run = await Run.findById(request.params.id).select(
      "agentName status createdAt durationMs error trace",
    );
    if (!run) throw notFound(`No run with id ${request.params.id}`);
    response.json({
      run: {
        id: run._id.toString(),
        agentName: run.agentName,
        status: run.status,
        createdAt: run.createdAt,
        durationMs: run.durationMs,
        // `error` is a nested (not sub-schema) path, so Mongoose auto-vivifies it to
        // `{}` on a successful run rather than leaving it undefined; a real error
        // always has a `code`.
        error: run.error?.code ? run.error : null,
      },
      spans: run.trace ?? [],
    });
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
