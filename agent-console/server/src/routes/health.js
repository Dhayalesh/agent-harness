import express from "express";
import { config } from "../config.js";
import { databaseName, databaseState } from "../db.js";
import { asyncHandler } from "../lib/http-error.js";
import { checkAgentcore } from "../services/agentcore.js";

export const healthRouter = express.Router();

/**
 * One place that answers "why is nothing working".
 *
 * The two dependencies fail in different ways — Mongo down blocks saving an agent,
 * AWS unconfigured blocks running one — and reporting them separately saves guessing.
 */
healthRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const agentcore = await checkAgentcore();
    const database = databaseState();
    response.json({
      ok:
        database === "connected" &&
        agentcore.ready &&
        agentcore.runtimeArnConfigured,
      database: {
        state: database,
        name: databaseName(),
        uri: redactUri(config.mongoUri),
      },
      agentcore,
    });
  }),
);

/** Atlas URIs carry the password inline; never echo it back. */
function redactUri(uri) {
  return uri.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
}
