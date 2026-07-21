const baseUrl = process.env.PLATFORM_URL ?? 'http://127.0.0.1:8788';
const apiKey = requiredEnvironment('PLATFORM_API_KEY');
const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};

const suffix = Date.now().toString(36);
const slug = process.env.PLATFORM_AGENT_SLUG ?? `database-agent-${suffix}`;
const agent = await json<{ id: string }>(`${baseUrl}/v1/agents`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    slug,
    name: 'Database Configured Agent',
    description: 'Agent definition, skills, tools, data, policy, and model stored in MongoDB.',
  }),
});

const version = await json<{ id: string; version: number }>(
  `${baseUrl}/v1/agents/${agent.id}/versions`,
  {
    method: 'POST',
    headers,
    body: JSON.stringify({
      definition: {
        systemPrompt: 'You are a platform-managed coding and support agent.',
        model: {
          provider: 'openrouter',
          model: process.env.PLATFORM_AGENT_MODEL ?? 'anthropic/claude-sonnet-4.6',
          secretRef: 'OPENROUTER_API_KEY',
          headers: { 'X-OpenRouter-Title': 'TrueAI Agent Platform' },
        },
        tools: [
          { name: 'read_file', version: '1' },
          { name: 'glob', version: '1' },
          { name: 'grep', version: '1' },
          { name: 'write_file', version: '1' },
          { name: 'edit_file', version: '1' },
          { name: 'bash', version: '1' },
        ],
        skills: [
          {
            name: 'verify-work',
            version: '1',
            description: 'Verify changes before reporting completion.',
            instructions:
              'Inspect relevant files, make the smallest safe change, and run focused checks.',
            allowedTools: ['read_file', 'glob', 'grep', 'write_file', 'edit_file', 'bash'],
          },
        ],
        dataSources: [
          {
            name: 'platform-handbook',
            type: 'inline',
            version: '1',
            config: {
              documents: [
                {
                  id: 'handbook-1',
                  text: 'All file mutations require explicit permission in the production environment.',
                },
              ],
            },
          },
        ],
        mcpServers: [],
        permissions: { mode: 'default', fallback: 'ask', rules: [] },
        limits: {
          maxTurns: 24,
          maxOutputTokens: 8192,
          maxTotalTokens: 100000,
          maxCostUsd: 5,
        },
        metadata: { example: true },
      },
    }),
  },
);

const deployment = await json<{ revision: number }>(
  `${baseUrl}/v1/agents/${agent.id}/deployments`,
  {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: version.id, environment: 'production' }),
  },
);

process.stdout.write(
  JSON.stringify(
    {
      agentId: agent.id,
      slug,
      versionId: version.id,
      version: version.version,
      deploymentRevision: deployment.revision,
    },
    null,
    2,
  ) + '\n',
);

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
