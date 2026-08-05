# AgentCore Runtime image for the agent-harness core.
#
# ARM64 is required by AgentCore Runtime, so the platform is pinned rather than
# left to the builder's architecture: an amd64 image builds and pushes without
# complaint and then fails to start in the runtime.
#
#   docker buildx build --platform linux/arm64 -t agent-harness:latest .
#
# The contract this serves is POST /invocations and GET /ping on 8080.

FROM --platform=linux/arm64 node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# `--omit=dev` after the build, not before: tsc and its types are devDependencies.
RUN npm prune --omit=dev

FROM --platform=linux/arm64 node:22-bookworm-slim AS runtime
WORKDIR /app

# git is here because agent records commonly name the shell tool and prompts ask
# for repository state. Add any other binary an mcp_servers record's `command`
# needs: a stdio server whose command is missing fails at agent resolution, so it
# takes down the first session that names it rather than logging a warning.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    AGENT_SERVICE_HOST=0.0.0.0 \
    AGENT_SERVICE_PORT=8080 \
    AGENT_WORKSPACE=/var/agent/workspace \
    AGENT_DATA_DIR=/var/agent/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# `node` is the unprivileged user the base image already ships. The workspace and
# data directories are created here so they are owned by it rather than by root,
# which is what the runtime would otherwise leave them as on first write.
RUN mkdir -p /var/agent/workspace /var/agent/data && chown -R node:node /var/agent
USER node

EXPOSE 8080
CMD ["node", "dist/service/agentcore.js"]
