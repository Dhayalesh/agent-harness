import { config } from "./config.js";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { Agent } from "./models/agent.js";
import { ModelProvider } from "./models/model-provider.js";
import { createRecord } from "./services/platform.js";

async function main() {
  await connectDatabase();
  const provider =
    (await ModelProvider.findOne({ enabled: true, isDefault: true })) ??
    (await ModelProvider.findOne({ enabled: true }));
  if (!provider) {
    throw new Error(
      "Create an enabled model provider before seeding an agent.",
    );
  }
  const name = "repo-reviewer";
  if (await Agent.exists({ name })) {
    process.stdout.write("seed: repo-reviewer already exists, left alone\n");
    await disconnectDatabase();
    return;
  }
  await createRecord(Agent, {
    name,
    description: "Reads the workspace and reviews code without changing it.",
    systemPrompt:
      "You are a concise code reviewer. Inspect the relevant files, report concrete findings, and do not modify the workspace.",
    modelProviderId: provider._id.toString(),
    tools: ["read_file", "glob", "grep"],
    skills: [],
    mcpServerIds: [],
    limits: { maxTurns: 12 },
    enabled: true,
    createdBy: config.createdBy,
  });
  process.stdout.write("seed: created repo-reviewer\n");
  await disconnectDatabase();
}

main().catch((error) => {
  process.stderr.write("seed failed: " + (error?.message ?? error) + "\n");
  process.exit(1);
});
