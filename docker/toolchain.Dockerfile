# Toolchain used by every workflow script and by CI, so the host needs only Docker.
FROM node:24.21.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git shellcheck shfmt \
  && rm -rf /var/lib/apt/lists/*

# pnpm comes from corepack, pinned by "packageManager" in package.json. Prepared here so runs need no
# download; the cache stays writable so a newer pinned version can still be fetched by a non-root user.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
  && corepack prepare pnpm@12.11.2 --activate \
  && pnpm --version \
  && chmod -R a+rwX /opt/corepack

ENV HOME=/tmp
WORKDIR /repo
