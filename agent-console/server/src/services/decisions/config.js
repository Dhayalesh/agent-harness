import path from "node:path";

export function decisionConfig(env = process.env) {
  const mode = env.SKILL_ROUTING_MODE?.trim() || "off";
  const fallback = env.SKILL_ROUTING_FAILURE?.trim() || "error";
  if (!["off", "laya"].includes(mode))
    throw new Error("SKILL_ROUTING_MODE must be off or laya");
  if (!["error", "none"].includes(fallback))
    throw new Error("SKILL_ROUTING_FAILURE must be error or none");
  const number = (key, initial, min, max, integer = true) => {
    const value = env[key]?.trim() ? Number(env[key]) : initial;
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  };
  const modelDir = env.LAYA_MODEL_DIR?.trim();
  if (mode === "laya" && (!modelDir || !path.isAbsolute(modelDir))) {
    throw new Error(
      "LAYA_MODEL_DIR must be an absolute path to a provisioned ONNX bundle",
    );
  }
  return {
    mode,
    fallback,
    modelDir,
    threshold: number("SKILL_ROUTING_THRESHOLD", 0.75, 0, 1, false),
    maxSelections: number("SKILL_ROUTING_MAX_SKILLS", 5, 1, 100),
    timeoutMs: number("LAYA_TIMEOUT_MS", 30000, 100, 120000),
    threads: number("LAYA_THREADS", 2, 1, 16),
  };
}
