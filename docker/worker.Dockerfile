# syntax=docker/dockerfile:1
# n8n-ops worker: outbound-only agent for an n8n Docker host. Build context: repository root.

FROM node:24.21.0-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@n8n-ops/worker..."
COPY config config
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @n8n-ops/worker run build

FROM node:24.21.0-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production \
    N8N_OPS_VERSION=${VERSION} \
    HEARTBEAT_FILE=/tmp/n8n-ops-worker-heartbeat
WORKDIR /app
COPY --from=build /src/apps/worker/dist ./dist
RUN mkdir -p /data && chown node:node /data
# Starts as root to hand /data to node and, with the Docker socket mounted, to give node the socket's
# group (docker/worker-entrypoint.sh); then runs as node. Docker access comes from that group or from
# the socket proxy, never from root. The health check runs as node too.
COPY --chmod=0755 docker/as-node.sh /usr/local/bin/as-node
COPY --chmod=0755 docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["as-node", "node", "dist/healthcheck.js"]
ENTRYPOINT ["worker-entrypoint"]
CMD ["node", "dist/index.js"]
