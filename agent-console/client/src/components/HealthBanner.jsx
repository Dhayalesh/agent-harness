import { Alert } from "@heroui/react";
import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Mongo and AgentCore fail in different ways and the fix differs, so the banner names
 * which one is down instead of saying something generic. It hides itself when both are
 * up.
 */
export function HealthBanner() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const result = await api.health();
        if (!cancelled) setHealth(result);
      } catch (error) {
        if (!cancelled) setHealth({ ok: false, apiError: error.message });
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!health || health.ok) return null;

  const problems = [];
  if (health.apiError) problems.push(`API unreachable: ${health.apiError}`);
  if (health.database && health.database.state !== "connected") {
    problems.push(`MongoDB ${health.database.state} at ${health.database.uri}`);
  }
  const core = health.agentcore;
  if (core && !core.runtimeArnConfigured) {
    problems.push(
      "No default AGENTCORE_RUNTIME_ARN set; each agent must name its own runtime.",
    );
  }
  if (core && !core.ready) {
    problems.push(core.error ?? "AWS is not configured.");
  }

  return (
    <div className="shrink-0 px-4 pt-4 sm:px-6 lg:px-8">
      <Alert
        color="warning"
        variant="flat"
        role="status"
        title="Degraded"
        classNames={{
          base: "items-start border border-warning-200 dark:border-warning-500/25",
          title: "text-small font-semibold",
        }}
      >
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tiny">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="mt-2 text-tiny text-default-500">
          Agents can be listed and edited without AWS; running one needs either
          AgentCore credentials and a runtime ARN, or LOCAL_HARNESS_URL pointed
          at a harness running on this machine.
        </p>
      </Alert>
    </div>
  );
}
