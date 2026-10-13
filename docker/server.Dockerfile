# syntax=docker/dockerfile:1
# n8n-ops server: API, MCP, pollers, and the built UI. Build context: repository root.

FROM node:24.21.0-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@n8n-ops/server..." --filter "@n8n-ops/web..."
COPY config config
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @n8n-ops/web run build && pnpm --filter @n8n-ops/server run build

FROM node:24.21.0-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production \
    N8N_OPS_VERSION=${VERSION} \
    PORT=8080 \
    WEB_DIR=web \
    MIGRATIONS_DIR=drizzle
WORKDIR /app
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
