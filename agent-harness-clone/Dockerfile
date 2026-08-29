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

# git is here because payloads commonly name the shell tool and prompts ask for
# repository state. Add any other binary a payload's stdio MCP server `command`
# needs: a stdio server whose command is missing fails at agent assembly, so it
# fails the invocation that named it rather than logging a warning.
#
# chromium is here for the `browser_use` tool (src/tools/web/browser-use-tool.ts),
# which looks for it at /usr/bin/chromium and simply does not register itself
# when it is absent — so removing this line degrades that one tool rather than
# breaking the image. It is a large dependency (fonts, X11 libs); leave it out
# of a deployment that never needs browser_use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    AGENT_SERVICE_HOST=0.0.0.0 \
    AGENT_SERVICE_PORT=8080 \
    AGENT_WORKSPACE=/var/agent/workspace

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# `node` is the unprivileged user the base image already ships. The workspace is
# created here so it is owned by it rather than by root, which is what the runtime
# would otherwise leave it as on first write. Each invocation gets its own
# directory beneath it, so concurrent payloads cannot read each other's files.
RUN mkdir -p /var/agent/workspace && chown -R node:node /var/agent
USER node

EXPOSE 8080
CMD ["node", "dist/headless/main.js"]
