# n8n-ops Project Foundation

Status: Foundation and all v1 features implemented (2026-10-14). Not yet released or deployed.

This document separates what exists in the repository from what is still planned. A planned item does not exist until its status and verification evidence say otherwise. Product behavior is specified in [requirements.md](requirements.md).

## Current truth

- Public repository `ShlomiPorush/n8n-ops`, default branch `main`, MIT license. GitHub settings match the owner's other public repositories: secret scanning with push protection, Dependabot security updates and vulnerability alerts on, Actions default token read-only, no rulesets or branch protection, default labels.
- pnpm workspace with `apps/server`, `apps/web`, `apps/worker` and `packages/shared`. Every v1 feature in `requirements.md` is implemented: sign-in with TOTP and setup, instances and scopes, problems and alerts, health, reports, the worker, backups and restore, the workflow map and moves, MCP and REST, settings with overrides, the audit log and live updates.
- Container images for `server` and `worker`, a production Compose file, a development Compose template, the four workflow scripts, path-filtered CI and Dependabot exist.
- `scripts/discover.sh` is a read-only operator tool. It has not been run against a production host; the product does not depend on its output.
- Tooling runs in containers. The development machine needs WSL with Docker only; Node.js, pnpm, shellcheck and shfmt come from the toolchain image.
- `docs/private/` exists only locally and is ignored. It holds environment-specific notes.

Verified locally on 2026-10-14 in WSL (Docker 29.8.2): `scripts/verify.sh` full sweep passes (guards, Biome, types, Vitest, builds, a healthy non-root stack, the readiness endpoint, two Playwright tests); `scripts/local.sh start`, `status`, `down`, `start` again with data kept, and `nuke` with and without confirmation; `scripts/release.sh` argument and preflight refusals. CI results are recorded on the pull request that introduced the foundation.

## Product intent and boundaries

- **Problem:** a team running many self-hosted n8n instances gets tens of failure emails per day and ignores them; backups are unreliable; moving workflows between instances is manual.
- **Product:** one self-hosted web application that monitors n8n instances through their public API, groups failures into problems, sends a small number of Telegram alerts and email reports, exposes failures to AI agents over MCP and REST, backs up workflows and credentials encrypted to S3-compatible storage, and helps consolidate instances.
- **Users:** one operator (single local account). Agents connect by approval (OAuth) or use read-only tokens made by hand.
- **Stage:** v1 implemented and verified in the test stack; first release and production deployment pending.
- **Deployment shape:** Docker Compose. `server` and its PostgreSQL run on any host that can reach the n8n instances. An optional `worker` runs on each n8n Docker host.
- **Non-goals for v1:** full-instance backup (`pg_dump`), automatic container discovery, write actions over REST or MCP, multiple users or roles, localization.

## Preparation decisions

| Decision | Status | Choice | Rationale |
|---|---|---|---|
| Publication posture | Approved | Public-ready; repository is public | Free CI. Environment-specific details live only in ignored `docs/private/`. |
| Repository language | Approved | English everywhere; no Hebrew in tracked files | Public-ready posture; the product has no localization. |
| Runtime shape | Approved | Docker Compose: `server`, `postgres`, optional `worker` per n8n host | Only `worker` has the Docker socket. |
| Language and runtime | Approved | TypeScript on Node.js 24 LTS (24.21.0) | Same ecosystem as n8n. |
| Package manager | Approved | pnpm 12 workspaces, pinned through `packageManager` and corepack | Three deployables sharing types. pnpm 12 runs install scripts only for packages listed under `allowBuilds` in `pnpm-workspace.yaml`. |
| Server framework | Approved | Hono with `@hono/node-server` | Small, typed. |
| Database | Approved | PostgreSQL 18 with Drizzle ORM and Drizzle migrations (postgres.js driver) | JSONB search of stored executions; Better Auth supports Drizzle. |
| Authentication | Approved | Better Auth: one user, password plus mandatory TOTP | Arrives with the first feature. |
| UI | Approved | React 19, Vite 8, Tailwind CSS 4, shadcn/ui (Vega style), lucide icons; served by `server` | Chosen from a prototype; English and LTR only; light and dark themes. |
| TypeScript | Approved | 6.0 | 7.0 is out, but the ecosystem templates still target 6.0. |
| Format and lint | Approved | Biome 2 | One tool for TS, JSON and CSS. |
| Tests | Approved | Vitest for unit tests, Playwright for end to end | Integration runs against the real container stack. |
| Bundling | Approved | esbuild bundles `server` and `worker` into single files; Vite builds `web` | Runtime images need no `node_modules`. |
| Workflow scripts | Approved | WSL Bash under `scripts/`, tooling in the toolchain container | Host needs Docker only. |
| Release artifact | Approved | `ghcr.io/shlomiporush/n8n-ops` and `ghcr.io/shlomiporush/n8n-ops-worker`, SemVer tags plus `latest` | Release publishes images only; deploying is the operator's action. |
| Versioning | Approved | SemVer from root `package.json` `version`; `CHANGELOG.md` with `Unreleased` | One product version for both images. |
| License | Approved | MIT | Owner's choice. |
| UI localization baseline | Approved override | No Hebrew, no RTL, no localization layer | The owner decided the product is English only. |
| GitHub configuration | Approved | Same as the owner's other public repositories; no rulesets | Owner's standard. |

## Publication and language policy

- Tracked files, commit messages, Issues and pull requests are in English. `scripts/verify.sh` fails on Hebrew characters in any non-ignored file.
- No environment-specific names, hostnames, IP addresses, instance lists or secrets in tracked files.

## Architecture

| Component | Responsibility | Path | Status |
|---|---|---|---|
| `server` | Better Auth, API for the UI, REST (`/api/v1`) and MCP (`/mcp`) for agents, pollers, alerts, reports, backups, scheduler, server-sent events; serves the built UI. | `apps/server` | Implemented |
| `web` | Variant D UI: sidebar shell, Overview, Problems, Instances, Workflows, Backups, Workers, Settings, Audit log, login and setup | `apps/web` | Implemented |
| `worker` | Pairing, job polling, n8n CLI exports through the Docker socket, age encryption, upload to a presigned URL, host-side health probes | `apps/worker` | Implemented |
| `shared` | Schemas, API key capability table, tar format; `@n8n-ops/shared/archive` (Node only) for sealed archives | `packages/shared` | Implemented |
| Database schema | Drizzle schema for all features; migration `0000_initial` | `apps/server/src/db`, `apps/server/drizzle` | Implemented |
| Images | Multi-stage builds; runtime runs as `node` (UID 1000) with a health check | `docker/server.Dockerfile`, `docker/worker.Dockerfile` | Implemented |
| Toolchain image | Node, pnpm, git, shellcheck, shfmt for scripts and CI | `docker/toolchain.Dockerfile` | Implemented |
| Discovery script | Read-only inventory of an n8n Docker host | `scripts/discover.sh` | Exists, not run on a production host |

Boundaries: only `server` opens the database; `worker` never receives database credentials; `server` never mounts the Docker socket; credential secrets will exist in plaintext only inside `worker` memory and are age-encrypted before leaving the host.

## Repository root

| Root file | Git tracking policy | Why this exact root location is required | Status |
|---|---|---|---|
| `README.md` | Tracked | GitHub and contributor convention | Exists |
| `AGENTS.md` | Tracked | Agent instruction discovery | Exists |
| `LICENSE` | Tracked | GitHub license detection | Exists |
| `CHANGELOG.md` | Tracked | Release workflow and contributor convention | Exists |
| `.gitignore` | Tracked | Git reads it from the root | Exists |
| `.gitattributes` | Tracked | Git reads it from the root; enforces LF | Exists |
| `package.json` | Tracked | pnpm workspace root and product version | Exists |
| `pnpm-workspace.yaml` | Tracked | pnpm requires it at the workspace root | Exists |
| `pnpm-lock.yaml` | Tracked | pnpm writes the lockfile at the workspace root | Exists |
| `biome.json` | Tracked | Biome 2 rejects a configuration outside the scanned root ("nested root configuration"); `--config-path` to `config/` does not work for a repository-wide check | Exists |
| `docker-compose.yml` | Tracked | Production deployment contract | Exists |
| `.env.example` | Tracked | Environment contract read by Compose | Exists |
| `docker-compose-dev.yml` | Ignored | Machine-local development stack used only by `scripts/local.sh`; created with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml` | Created per machine |
| `.env` | Ignored | Real environment values for a deployment | Created per deployment |

Shared TypeScript settings are in `config/tsconfig.base.json`. Dockerfiles, their per-Dockerfile ignore files, the development Compose template and `docker/dev.env` (development-only values, not secrets) are in `docker/`.

## Containers

| Service | Runtime user | Health check | Persistent state | Host directory | Named volume | Backup lifecycle |
|---|---|---|---|---|---|---|
| `server` | `node`, UID 1000 | `node dist/healthcheck.js` calls `/healthz/ready` (database reachable) | App secrets key file (from the first feature on) | `./data` (production), `${N8N_OPS_DATA_DIR}/server` (development) | None | Operator downloads the key from Settings; never in the repository |
| `data-init` (production only) | root with only `CHOWN` and `DAC_READ_SEARCH`, one-shot | None; `server` waits for it to exit successfully | None | `./data` | None | Not applicable |
| `postgres` | `postgres`, UID 999 (official entrypoint drops privileges) | `pg_isready` | Database files | `./postgres-data` (production), `${N8N_OPS_DATA_DIR}/postgres` (development) | None | Nightly encrypted dump to S3 (requirement D8, planned) |
| `worker` | `node`, UID 1000; through `socket-proxy`, or with the Docker socket's group via `group_add` | `node dist/healthcheck.js` checks the last heartbeat | Worker identity file (planned) | `./data` beside the compose file that Add worker generates (production), `${N8N_OPS_DATA_DIR}/worker` (development) | None | Re-pair on loss |

Socket access is root-equivalent on the host even for a non-root process. It is accepted for `worker` only and contained by no inbound ports, outbound HTTPS, a revocable identity and no database credentials. `scripts/local.sh status` and `scripts/verify.sh` fail if any process in these services runs as UID 0.

Development data lives in `${XDG_DATA_HOME:-~/.local/share}/n8n-ops-dev` on the Linux file system (PostgreSQL does not work reliably on `/mnt/c`). Verification uses a temporary directory and removes it.

## Foundation implementation

| Order | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Repository baseline | Done | Workspace builds; lockfile committed |
| 2 | Toolchain container | Done | All scripts run on WSL without Node installed |
| 3 | Runtime and development environment | Done | Stack healthy; UIDs 1000, 999, 1000; no `build:` in Compose files |
| 4 | Local workflow | Done | `start`, `status`, `down`, data kept, `nuke` confirmed and refused |
| 5 | Verify workflow | Done | Full sweep passes locally and in CI |
| 6 | Try PR workflow | Done | Exercised against the foundation pull request (see the pull request) |
| 7 | Release workflow | Done, not yet used | Preflight refusals and dry run checked; no release has been published |
| 8 | Path-filtered CI | Done | Change detection, guards, verify, summary job |
| 9 | Dependency management | Done | `.github/dependabot.yml` for npm, Actions, Docker and Compose |
| 10 | GitHub configuration | Done | Matches the owner's standard; nothing changed |

Deferred from the foundation, with reason:

- None. Integration and end-to-end tests run against a disposable n8n 2.44 and S3Mock in the test stack.

## Workflow contracts

All scripts: Bash inside WSL (or any Linux with Docker), `#!/usr/bin/env bash`, `set -euo pipefail`, LF, executable, repository root from the script location, Node tooling inside the toolchain container. Shared helpers are in `scripts/lib/common.sh`.

- **`scripts/local.sh`** `build | up | start | down | status | logs | nuke`. Builds `n8n-ops-server:dev` and `n8n-ops-worker:dev`; requires root `docker-compose-dev.yml` and never falls back to the production file; `start` waits for health and checks runtime UIDs; `down` keeps data; `nuke` asks for the word `nuke` and deletes only a directory whose name starts with `n8n-ops-dev`.
- **`scripts/verify.sh`** `[--changed [BASE]] [--guards-only] [--skip-guards] [--skip-integration] [--design regular|compact]`. Guards: Hebrew, Compose `build:`, shellcheck, shfmt, executable bits. Checks: Biome, `tsc`, Vitest, builds (filtered to changed packages and dependents with `--changed`; shared root files force a full run; documentation-only changes skip checks). Integration: builds `:verify` images, starts the stack from `docker/docker-compose-dev.example.yml` with a temporary data directory, checks UIDs and readiness, runs Playwright from the official image once per design on a fresh stack each time (`--design` picks one), then removes everything.
- **`scripts/try-pr.sh`** `<number> | status | restore`. Fetches the pull request into a worktree under `~/.cache/n8n-ops/try-pr`, dumps the development database, rebuilds only affected images, restarts only those services, confirms the running image is the new one. `restore` puts back the previous images and the database and removes the worktree. Never merges, pushes or touches the checkout.
- **`scripts/release.sh`** `--target ghcr --bump <patch|minor|major> [--dry-run]`. Preflight: on `main`, clean, in sync with `origin/main`, release notes under `Unreleased`, unused tag and image version. Then full verify, version and changelog update, release commit of exactly `package.json` and `CHANGELOG.md`, annotated tag, image build and push, then push of the commit and tag. Requires `docker login ghcr.io` beforehand. Never deploys.

## CI

`.github/workflows/ci.yml`: `Detect changes` (paths filter: anything except documentation), `Guards` (always), `Verify (regular)` and `Verify (compact)` (one job per design, side by side, each running the whole script with `--design`; only when code changed on pull requests; always on `main`, manual runs and the weekly Monday sweep), `CI summary` (fails if any job failed or was cancelled; skipped jobs count as success). Pull request runs cancel superseded runs; `main` runs are never cancelled. Actions are pinned to commit SHAs; the token is read-only except `pull-requests: read` for change detection.

## Known unknowns

| Question | Why it matters | Needed | Owner |
|---|---|---|---|
| Where `server` is hosted (the reverse proxy is Traefik) | Production deployment only | Decide before the first deployment | Shlomi |
| Encrypted versus searchable stored executions (B4) | Stored executions are plain JSONB for search; at-rest protection relies on the database host | Owner decision | Shlomi |

## Next step

First release with `scripts/release.sh --target ghcr --bump minor` (owner's decision), then deployment and the production prerequisites in `requirements.md` section 9. Accepting v1 (section 11) needs the real instances, Telegram and storage.
