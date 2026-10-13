# AGENTS.md

## Project

n8n-ops is a self-hosted operations console for many n8n instances: failure monitoring and problem grouping, Telegram alerts and email reports, MCP and REST access for agents, encrypted backups to S3-compatible storage, and instance consolidation.

**Stage: foundation done, no product features yet.**

- Product requirements: `docs/requirements.md`
- Foundation and repository contract (what exists, decisions, scripts, CI): `docs/project-foundation.md`

Items marked planned in those documents do not exist yet. Check the repository before assuming a file, command or feature.

## Repository policies

- The repository is public. Everything tracked is in English. `scripts/verify.sh` fails on Hebrew characters.
- Never commit environment-specific details: instance names, hostnames, IP addresses, local paths, API keys, tokens or passwords. They belong in the ignored `docs/private/` or in ignored environment files.
- The product UI is English only and LTR only. Do not add localization or RTL support.
- Keep the repository root minimal. Every root file is listed and justified in the foundation document.
- Add user-visible or operational changes under `Unreleased` in `CHANGELOG.md`. Do not bump versions in pull requests; `scripts/release.sh` does that.
- Install with the lockfile (`pnpm install --frozen-lockfile`, done by the scripts).

## Layout

- `apps/server`: Hono on Node.js, Drizzle with PostgreSQL (migrations in `apps/server/drizzle`, run on start). Serves the built UI. Never mounts the Docker socket.
- `apps/web`: React, Vite, Tailwind CSS, shadcn/ui (Vega style). Add components with the shadcn CLI from `apps/web`.
- `apps/worker`: outbound-only agent for an n8n Docker host. The only component with the Docker socket. Never gets database credentials.
- `packages/shared`: zod schemas and types shared by server and UI. Imported as TypeScript source; no build step.
- `config/tsconfig.base.json`: shared compiler settings. `biome.json` stays at the root (see traps).
- `docker/`: Dockerfiles with per-Dockerfile ignore files, the toolchain image, the development Compose template and `dev.env`.

## Commands

All scripts are Bash for WSL or Linux with Docker. Node, pnpm, shellcheck and shfmt run inside the toolchain container, so the host needs only Docker.

- `scripts/local.sh build|up|start|down|status|logs|nuke`: development stack.
- `scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-guards] [--skip-integration]`: the only verification entry point. CI runs the same script.
- `scripts/try-pr.sh <number>|status|restore`: run a pull request on the development stack.
- `scripts/release.sh --target ghcr --bump patch|minor|major [--dry-run]`: release images. Never deploys.
- Ad-hoc commands in the toolchain: `source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm ..."`.

Before finishing a change, run `scripts/verify.sh` (or `--changed` for a quick pass) and report its result.

## Traps

- pnpm 12 blocks dependency install scripts. Allow a package explicitly under `allowBuilds` in `pnpm-workspace.yaml` only when it needs one.
- Biome 2 must find `biome.json` at the repository root; a config under `config/` fails with "nested root configuration".
- Development and verification data must live on the Linux file system, not under `/mnt/c`; PostgreSQL fails on the Windows mount.
- `apps/web/src/lib/utils.ts` re-exports `cn` from the `cn` package. That is how the current shadcn preset works; do not "fix" the import.
- Vitest in `apps/web` only includes `src/**/*.test.ts(x)`; Playwright specs in `apps/web/e2e` run through `scripts/verify.sh` against the container stack.
- The repository uses the GitHub noreply address as the local `user.email`; GitHub rejects pushes that expose the private address.

## Docker

- `docker-compose.yml` (tracked) is the production deployment and references published images on GHCR. The `worker` service is behind the `worker` profile.
- `docker-compose-dev.yml` (root, ignored, never committed) is the development stack. Create it with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml` and use it only through `scripts/local.sh`. CI, verify and release use the tracked template instead.
- Compose files never contain `build:`; the scripts build images explicitly. The guard in `scripts/verify.sh` enforces it.
- Runtime variables come from an `env_file`: `.env` in production (contract in `.env.example`), `docker/dev.env` for development and verification. Compose interpolation is limited to image tags, the host port, data directories and the Docker socket group.
- Every application container runs as a non-root user and has a real health check. `scripts/local.sh status` and `scripts/verify.sh` fail if a process runs as UID 0. The `worker` reaches the Docker socket through the socket's group (`group_add`), never as root.
- Persistent data uses bind-mounted host directories, not named volumes. `down` keeps them; only a confirmed `nuke` deletes the validated development data directory.
- Logs go to stdout and stderr.

## Safety

- Never change a production n8n instance (environment flags, restarts, API key creation) without explicit approval from the owner.
- Development and tests use disposable containers, never production instances.
