import cors from "cors";
import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { HttpError } from "./lib/http-error.js";
import { agentsRouter } from "./routes/agents.js";
import { catalogueRouter } from "./routes/catalogue.js";
import { chatsRouter } from "./routes/chats.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { healthRouter } from "./routes/health.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { modelProvidersRouter } from "./routes/model-providers.js";
import { runsRouter } from "./routes/runs.js";
import { skillsRouter } from "./routes/skills.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  // Prompts and system prompts are long; the default 100kb limit is too small.
  app.use(express.json({ limit: "5mb" }));

  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/catalogue", catalogueRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/model-providers", modelProvidersRouter);
  app.use("/api/mcp-servers", mcpServersRouter);
  app.use("/api/skills", skillsRouter);
  app.use("/api/chats", chatsRouter);
  app.use("/api/runs", runsRouter);

  // The Vite proxy owns development. After npm run build, serve the same frontend
  // from this process so npm start is a complete, same-origin production app.
  const clientDirectory = fileURLToPath(
    new URL("../../client/dist/", import.meta.url),
  );
  const clientEntry = fileURLToPath(
    new URL("../../client/dist/index.html", import.meta.url),
  );
  if (existsSync(clientEntry)) {
    app.use(express.static(clientDirectory));
    app.get("*", (request, response, next) => {
      if (request.path.startsWith("/api/")) return next();
      return response.sendFile(clientEntry);
    });
  }

  app.use((request, response) => {
    response
      .status(404)
      .json({ error: `No route for ${request.method} ${request.path}` });
  });

  // Four arguments, or Express treats this as ordinary middleware and the error
  // reaches the default handler instead.
  app.use((error, _request, response, _next) => {
    if (error instanceof HttpError) {
      return response
        .status(error.status)
        .json({ error: error.message, details: error.details });
    }
    // Mongoose validation that the zod layer did not already catch.
    if (error?.name === "ValidationError") {
      return response.status(400).json({
        error: "Validation failed",
        details: Object.entries(error.errors ?? {}).map(([field, issue]) => ({
          field,
          message: issue.message,
        })),
      });
    }
    if (error?.type === "entity.parse.failed") {
      return response.status(400).json({ error: "Request body is not valid JSON" });
    }
    // Multipart limits, which the JSON body parser never sees. Reported with the
    // configured ceiling, because "too large" without a number is not actionable.
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return response.status(413).json({
          error:
            "That file is larger than the " +
            megabytes(config.uploads.maxFileBytes) +
            " upload limit",
        });
      }
      if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_PART_COUNT") {
        return response.status(400).json({
          error: `Attach at most ${config.uploads.maxFiles} files at a time`,
        });
      }
      return response
        .status(400)
        .json({ error: `Upload rejected: ${error.message}` });
    }
    if (error?.type === "entity.too.large" || error?.status === 413) {
      return response.status(413).json({ error: "Request body exceeds the 5 MB limit" });
    }
    process.stderr.write(
      `agent-console: unhandled failure: ${error?.stack ?? error}\n`,
    );
    return response.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
