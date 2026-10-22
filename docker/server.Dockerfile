# syntax=docker/dockerfile:1
# n8n-ops server: API, MCP, pollers, and the built UI. Build context: repository root.

FROM node:24.21.0-bookworm-slim AS deps
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

# The UI builds in its own stage, so a server change does not rebuild it. One build holds both designs.
FROM deps AS web
COPY apps/web apps/web
RUN pnpm --filter @n8n-ops/web run build

FROM deps AS build
COPY apps/server apps/server
RUN pnpm --filter @n8n-ops/server run build

FROM node:24.21.0-bookworm-slim
# pg_dump for the nightly backup of the n8n-ops database (must match the PostgreSQL 18 server).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ARG VERSION=dev
ENV NODE_ENV=production \
    N8N_OPS_VERSION=${VERSION} \
    PORT=8080 \
    WEB_DIR=web \
    SKILL_DIR=skill \
    MIGRATIONS_DIR=drizzle
WORKDIR /app
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=web /src/apps/web/dist ./web
# The agent skill, served at /connect/skill/ with the public URL filled in.
COPY packages/skill/n8n-ops ./skill
# /backups is where a host folder is mapped for local backup destinations.
RUN mkdir -p /data /backups && chown node:node /data /backups
# Starts as root to hand /data to node, then runs as node (docker/server-entrypoint.sh). The health
# check and any command run with "docker compose exec -u node" run as node too.
COPY --chmod=0755 docker/as-node.sh /usr/local/bin/as-node
COPY --chmod=0755 docker/server-entrypoint.sh /usr/local/bin/server-entrypoint
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["as-node", "node", "dist/healthcheck.js"]
ENTRYPOINT ["server-entrypoint"]
CMD ["node", "dist/index.js"]
