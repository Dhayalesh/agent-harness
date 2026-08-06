/**
 * The API client.
 *
 * One `request` helper so every failure surfaces the same way: the server's `error`
 * string and, when validation failed, the per-field `details` the form renders next to
 * the inputs that caused them.
 */

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details ?? [];
  }
}

async function request(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(
      `Unexpected response from the API: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      payload.error ?? `HTTP ${response.status}`,
      response.status,
      payload.details,
    );
  }
  return payload;
}

export const api = {
  health: () => request("/health"),
  dashboard: () => request("/dashboard"),
  catalogue: () => request("/catalogue"),
  tools: () => request("/agents/meta/tools"),

  listAgents: ({ q = "", archived = false } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (archived) params.set("archived", "true");
    const query = params.toString();
    return request(`/agents${query ? `?${query}` : ""}`);
  },
  getAgent: (id) => request(`/agents/${id}`),
  createAgent: (body) => request("/agents", { method: "POST", body }),
  updateAgent: (id, body) =>
    request(`/agents/${id}`, { method: "PATCH", body }),
  deleteAgent: (id, { withRuns = false } = {}) =>
    request(`/agents/${id}${withRuns ? "?withRuns=true" : ""}`, {
      method: "DELETE",
    }),

  listModelProviders: ({ q = "" } = {}) =>
    request(`/model-providers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  getModelProvider: (id) => request(`/model-providers/${id}`),
  createModelProvider: (body) =>
    request("/model-providers", { method: "POST", body }),
  updateModelProvider: (id, body) =>
    request(`/model-providers/${id}`, { method: "PATCH", body }),
  deleteModelProvider: (id) =>
    request(`/model-providers/${id}`, { method: "DELETE" }),

  listMcpServers: ({ q = "" } = {}) =>
    request(`/mcp-servers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  getMcpServer: (id) => request(`/mcp-servers/${id}`),
  createMcpServer: (body) =>
    request("/mcp-servers", { method: "POST", body }),
  updateMcpServer: (id, body) =>
    request(`/mcp-servers/${id}`, { method: "PATCH", body }),
  deleteMcpServer: (id) =>
    request(`/mcp-servers/${id}`, { method: "DELETE" }),

  listSkills: ({ q = "" } = {}) =>
    request(`/skills${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  getSkill: (id) => request(`/skills/${id}`),
  createSkill: (body) => request("/skills", { method: "POST", body }),
  updateSkill: (id, body) =>
    request(`/skills/${id}`, { method: "PATCH", body }),
  deleteSkill: (id) => request(`/skills/${id}`, { method: "DELETE" }),

  previewPayload: (id, body) =>
    request(`/agents/${id}/preview`, { method: "POST", body }),
  invokeAgent: (id, body, signal) =>
    request(`/agents/${id}/invoke`, { method: "POST", body, signal }),

  listRuns: ({
    agentId,
    status,
    runtimeSessionId,
    limit,
    sort,
    cursor,
    includeOutput,
  } = {}) => {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (status) params.set("status", status);
    if (runtimeSessionId) params.set("runtimeSessionId", runtimeSessionId);
    if (limit) params.set("limit", String(limit));
    if (sort) params.set("sort", sort);
    if (cursor) params.set("cursor", cursor);
    if (includeOutput) params.set("includeOutput", "true");
    const query = params.toString();
    return request(`/runs${query ? `?${query}` : ""}`);
  },
  getRun: (id) => request(`/runs/${id}`),
  deleteRun: (id) => request(`/runs/${id}`, { method: "DELETE" }),

  listChats: ({ agentId } = {}) => {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    const query = params.toString();
    return request(`/chats${query ? `?${query}` : ""}`);
  },
  createChat: (body) => request("/chats", { method: "POST", body }),
  getChat: (id) => request(`/chats/${id}`),
  deleteChat: (id) => request(`/chats/${id}`, { method: "DELETE" }),
  sendChatMessage: (id, content) =>
    request(`/chats/${id}/messages`, {
      method: "POST",
      body: { content },
    }),
};

export { ApiError };
