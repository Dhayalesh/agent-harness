import { parentPort, workerData } from "node:worker_threads";
import { Laya } from "@receptron/laya";

// A provisioned directory prevents implicit model downloads on a request path.
const model = await Laya.load({
  modelDir: workerData.modelDir,
  executionProviders: ["cpu"],
  sessionOptions: { intraOpNumThreads: workerData.threads },
});

parentPort.on("message", async ({ state, options, instructions }) => {
  try {
    const scores = [];
    // Independent binary questions allow multiple matches and bound tensor memory.
    for (const option of options) {
      const result = await model.systemOne(state, {
        relevant: {
          type: "choice",
          instructions: instructions.replace(
            "{description}",
            option.description,
          ),
          criteria: ["yes", "no"],
        },
      });
      scores.push({
        id: option.id,
        score: result.answers.relevant.probabilities.yes,
      });
    }
    parentPort.postMessage({ scores });
  } catch {
    // Native/provider errors can contain input text or paths. Keep them private.
    parentPort.postMessage({ error: "INFERENCE_FAILED" });
  }
});
