# AGENTS.md

## Project

n8n-ops is a self-hosted operations console for many n8n instances: failure monitoring and problem grouping, Telegram alerts and email reports, MCP and REST access for agents, encrypted backups to S3-compatible storage, and instance consolidation.

**Stage: v1 implemented; not released or deployed yet.**

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

- `apps/server`: Hono on Node.js, Drizzle with PostgreSQL (migrations in `apps/server/drizzle`, generated with `drizzle-kit generate`, run on start). `src/routes` are HTTP routers, `src/services` hold the logic (problems, alerts, health, backups, workers, workflows, moves, agent queries), `src/features.ts` mounts routers and scheduled jobs. Serves the built UI. Never mounts the Docker socket.
- `apps/web`: React, Vite, Tailwind CSS, shadcn/ui (Vega style), React Router, TanStack Query. Add components with the shadcn CLI from `apps/web`. `src/components/spectrum` holds components adapted from Spectrum UI (Apache-2.0; registry items at `https://ui.spectrumhq.in/r/<name>.json`), kept close to upstream and excluded from the linter like `components/ui`. Status pills (`Tone`), figures (`StatCard`) and empty lists (`EmptyState`) have one shared component each; use them instead of new variants. End-to-end specs in `apps/web/e2e` run in file order against the test stack and share state through `test-results/e2e-state.json`.
- `apps/web-compact`: the Compact design (the v3 design language): the same pages and API in a denser layout with a top bar, global search, bottom sheets on phones, a page save bar, sortable tables and filter pickers. Every colour, size and radius is a token in `src/index.css`; `src/design.test.ts` guards them. Pages use `src/components/kit.tsx` and the shared behaviours (`save-bar.tsx`, `confirm.tsx`, `filter-bar.tsx`, `ui/table.tsx`, `ui/dialog.tsx`, `lib/toast.ts`, timings in `lib/behavior.ts`). Built with Vite `base: "/compact/"`; its router stays at the root.
- **Two designs, one choice.** Settings → General → Design (`general.design`, `regular` by default) chooses the design for the whole installation. The server keeps the choice in memory (`ctx.settings.design()`, loaded after migrations and updated where General is stored; this assumes one server process) and serves it in `src/http/web.ts`: `/assets/*` from Regular and `/compact/assets/*` from Compact, cached for good, a missing asset a 404; every other address gets the chosen design's `index.html`. Each `index.html` carries `<meta name="n8n-ops-design">`. **Every UI change goes into both apps and both end-to-end suites**; a pull request that changes only one says why. `scripts/verify.sh` runs both suites, each on a fresh stack (Compact's stack gets the design stored before its first-run setup).
- `apps/worker`: outbound-only agent for an n8n Docker host. The only component with the Docker socket. Never gets database credentials.
- `packages/shared`: schemas, the API key capability table and the tar format, shared by server, worker and UI. `@n8n-ops/shared/archive` (age + gzip) is Node only; never import it from the UI. Imported as TypeScript source; no build step.
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
- Vitest in `apps/web` and `apps/web-compact` only includes `src/**/*.test.ts(x)`; Playwright specs in each app's `e2e` run through `scripts/verify.sh` against the container stack.
- The repository uses the GitHub noreply address as the local `user.email`; GitHub rejects pushes that expose the private address.
- Sign-in is rate limited (5 per 5 minutes). End-to-end spec files sign in through `signIn()`, which reuses the previous file's session; a new spec that signs in with a password on its own will hit the limit.
- In the verification stack the server sends Telegram calls to a stand-in Bot API inside the Playwright runner (`TELEGRAM_API_URL=http://e2e-runner:8099`) and email to Mailpit (`mail:1025`, API on `mail:8025`). Never point `TELEGRAM_API_URL` anywhere in production.

## Docker

- `docker-compose.yml` (tracked) is the production deployment and references published images on GHCR. The `worker` service is behind the `worker` profile.
- `docker-compose-dev.yml` (root, ignored, never committed) is the development stack. Create it with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml` and use it only through `scripts/local.sh`. CI, verify and release use the tracked template instead.
- Compose files never contain `build:`; the scripts build images explicitly. The guard in `scripts/verify.sh` enforces it.
- Runtime variables come from an `env_file`: `.env` in production (contract in `.env.example`), `docker/dev.env` for development and verification. Compose interpolation is limited to image tags, the host port, data directories, the Docker socket group and, in the development template, `TELEGRAM_API_URL` (empty except under `scripts/verify.sh`).
- Every application container runs as a non-root user and has a real health check. `scripts/local.sh status` and `scripts/verify.sh` fail if a process runs as UID 0. In the development and verification stacks the `worker` reaches Docker only through `socket-proxy` (wollomatic/socket-proxy, allowlist of ping and exec in the n8n container), the same layout the Add worker dialog generates; without the proxy a worker uses the socket's group (`group_add`), never root.
- Persistent data uses bind-mounted host directories, not named volumes. `down` keeps them; only a confirmed `nuke` deletes the validated development data directory.
- Logs go to stdout and stderr.

## Safety

- Never change a production n8n instance (environment flags, restarts, API key creation) without explicit approval from the owner.
- Development and tests use disposable containers, never production instances.
