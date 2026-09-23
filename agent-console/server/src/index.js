import { createApp } from "./app.js";
import { config } from "./config.js";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { skillDecisionBackend } from "./services/skill-routing.js";

async function main() {
  const database = await connectDatabase();
  // The resolved target, not just "connected". An ambient MONGODB_URI in the shell wins
  // over the one in .env, because Node's --env-file does not overwrite a variable that
  // is already set, and silently writing agents to the wrong cluster is the kind of
  // thing you want to notice on line one.
  process.stdout.write(
    `agent-console: MongoDB ${redactUri(config.mongoUri)} (database ${database.name})\n`,
  );

  const server = createApp().listen(config.port, config.host, () => {
    process.stdout.write(
      `agent-console: API on http://${config.host}:${config.port}\n`,
    );
    if (config.localHarness.url) {
      // Matches resolveRuntime's own precedence: local wins unconditionally when
      // set, so the startup banner should not claim AgentCore is what runs.
      process.stdout.write(
        `agent-console: local harness ${config.localHarness.url} (LOCAL_HARNESS_URL ` +
          "overrides AGENTCORE_RUNTIME_ARN when both are set)\n",
      );
    } else if (config.agentcore.runtimeArn) {
      process.stdout.write(
        `agent-console: AgentCore runtime ${config.agentcore.runtimeArn} ` +
          `(${config.agentcore.qualifier || "DEFAULT"} endpoint, region ${config.agentcore.region})\n`,
      );
    } else {
      process.stderr.write(
        "agent-console: AGENTCORE_RUNTIME_ARN is unset and LOCAL_HARNESS_URL is unset. Records " +
          "can be managed, but invoking an agent fails until one of them is configured.\n",
      );
    }
    process.stderr.write(
      "agent-console: this API has no authentication of its own. Anyone who can reach it can " +
        "create an agent, and an agent chooses a system prompt and a tool set the AgentCore " +
        "runtime will execute with this deployment's IAM identity. Keep it on loopback or put a " +
        "front door in front of it.\n",
    );
  });

  // `listen` reports failure by emitting on the server rather than by throwing, so
  // without this an occupied port arrives as an unhandled 'error' event and a stack
  // trace instead of the one line that says what to do about it. Attaching after
  // `listen` is in time: the event fires on a later tick.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `agent-console: port ${config.port} is already in use. Stop whatever is on it, or set ` +
          "PORT to something else.\n",
      );
    } else {
      process.stderr.write(`agent-console: listen failed: ${error.message}\n`);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    process.stdout.write(`\nagent-console: ${signal}, shutting down\n`);
    server.close(() => {
      void Promise.allSettled([disconnectDatabase(), skillDecisionBackend.close()])
        .finally(() => process.exit(0));
    });
    // A run in flight holds the connection for up to AGENTCORE_TIMEOUT_MS; do not wait.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Atlas URIs carry the password inline; never print it. */
function redactUri(uri) {
  return uri.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
}

main().catch((error) => {
  process.stderr.write(
    `agent-console: failed to start: ${error?.message ?? error}\n`,
  );
  if (String(error?.message).includes("ECONNREFUSED")) {
    process.stderr.write(
      "agent-console: MongoDB refused the connection. Start mongod, or point MONGODB_URI at " +
        "an Atlas cluster.\n",
    );
  }
  process.exit(1);
});
