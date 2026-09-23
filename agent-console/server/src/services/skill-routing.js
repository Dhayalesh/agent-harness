import { config } from "../config.js";
import { HttpError } from "../lib/http-error.js";
import { decide } from "./decisions/service.js";
import { LayaBackend } from "./decisions/laya.js";

export const skillDecisionBackend = new LayaBackend();

export async function routeSkills(
  {
    skills,
    prompt = "",
    sessionHistory = [],
    attachments = [],
    operation,
    signal,
  },
  { settings = config.skillRouting, backend = skillDecisionBackend } = {},
) {
  if (settings.mode === "off")
    return { skills, decision: { status: "disabled" } };
  if (operation === "compact")
    return {
      skills: [],
      decision: { status: "skipped", reason: "compaction" },
    };
  const candidates = skills.filter((skill) => skill.value.enabled);
  const started = Date.now();
  // The English checkpoint can otherwise classify the old task rather than the
  // new request. Carry history only for explicit conversational references.
  const contextUsed =
    /\b(it|its|them|those|these|that|this|same|previous|above|earlier|continue)\b/i.test(
      prompt,
    ) && sessionHistory.length > 0;
  let inputTruncated = false;
  const bound = (value, length) => {
    const text = String(value ?? "");
    if (text.length > length) inputTruncated = true;
    return text.slice(0, length);
  };
  // Put the latest intent first: the checkpoint truncates its state to its context window.
  const state = [
    bound(prompt, 1200),
    ...attachments
      .slice(0, 5)
      .map(
        (file) =>
          `Attachment: ${bound(file.filename, 80)} (${bound(file.contentType, 80)})`,
      ),
    ...(contextUsed ? sessionHistory : [])
      .slice(-2)
      .reverse()
      .map(
        (message) => `Previous ${message.role}: ${bound(message.content, 200)}`,
      ),
  ].join("\n");
  try {
    const options = candidates.map((skill) => {
      const description = skill.value.routingDescription?.trim();
      if (!description) throw new Error("MISSING_DESCRIPTION");
      return {
        id: skill.document._id.toString(),
        label: skill.value.name,
        description,
      };
    });
    const result = await decide(
      {
        purpose: "skills",
        selectionMode: "multiple",
        state,
        options,
        instructions: "Does the request involve {description}?",
        threshold: settings.threshold,
        maxSelections: settings.maxSelections,
      },
      { backend, config: settings, signal },
    );
    const ids = new Set(result.selectedIds);
    return {
      skills: candidates.filter((skill) =>
        ids.has(skill.document._id.toString()),
      ),
      decision: {
        ...result,
        backend: "laya",
        durationMs: Date.now() - started,
        inputTruncated,
        contextUsed,
      },
    };
  } catch (error) {
    if (signal?.aborted)
      throw new HttpError(499, "Skill selection was cancelled");
    const known = [
      "MISSING_DESCRIPTION",
      "TIMEOUT",
      "CAPACITY",
      "WORKER_FAILED",
      "WORKER_EXITED",
      "INFERENCE_FAILED",
      "INVALID_SCORES",
      "TOO_MANY_MATCHES",
    ];
    const code = known.includes(error.message)
      ? error.message
      : "ROUTING_FAILED";
    const decision = {
      status: "error",
      backend: "laya",
      code,
      fallback: settings.fallback,
      durationMs: Date.now() - started,
    };
    process.stderr.write(
      JSON.stringify({ event: "skills.routing.failed", ...decision }) + "\n",
    );
    if (settings.fallback === "none") return { skills: [], decision };
    throw new HttpError(503, `Skill selection unavailable (${code})`, [
      { field: "skillRouting", message: code },
    ]);
  }
}
