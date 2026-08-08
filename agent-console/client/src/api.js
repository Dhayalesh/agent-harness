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

/**
 * The same request, read as frames.
 *
 * Kept beside `request` rather than folded into it because the two fail
 * differently: this one has already returned a 200 by the time anything can go
 * wrong, so a failure arrives as an event and the shared error handling above
 * would never see it. A non-2xx still comes back as the ordinary JSON shape,
 * which is why the pre-stream branch reuses it.
 */
async function streamRequest(path, { body, onEvent, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(
        `Unexpected response from the API: ${text.slice(0, 200)}`,
        response.status,
      );
    }
    throw new ApiError(
      payload.error ?? `HTTP ${response.status}`,
      response.status,
      payload.details,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed;
  let failure;

  const handle = (event) => {
    if (event.type === "console.completed") completed = event;
    else if (event.type === "console.failed") failure = event;
    onEvent?.(event);
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    // A frame is delimited by a blank line, not by a chunk: a long tool result
    // routinely arrives split across several reads.
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const event = parseFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) handle(event);
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (failure) {
    throw new ApiError(failure.error ?? "The run failed", 502);
  }
  if (!completed) {
    throw new ApiError("The stream ended before the run completed", 502);
  }
  return { chat: completed.chat, run: completed.run };
}

function parseFrame(frame) {
  const data = [];
  for (const line of frame.split("\n")) {
    // Comment lines are the keep-alive; they exist for the network, not for us.
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  try {
    return JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
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
  /** Same call, same `{ chat, run }` result, with the events on the way there. */
  streamChatMessage: (id, content, { onEvent, signal } = {}) =>
    streamRequest(`/chats/${id}/messages`, {
      body: { content },
      onEvent,
      ...(signal ? { signal } : {}),
    }),
};

export { ApiError };
