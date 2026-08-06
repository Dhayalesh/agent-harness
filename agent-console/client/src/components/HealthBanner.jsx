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
    <div className="banner" role="status">
      <strong>Degraded</strong>
      <ul>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <p className="banner-hint">
        Agents can be listed and edited without AWS; running one needs
        credentials and a runtime ARN. There is no local fallback.
      </p>
    </div>
  );
}
