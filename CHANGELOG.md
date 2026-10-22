# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- When the server cannot sign in to PostgreSQL or reach it at startup, it says why in one line and what to do, instead of a stack trace. A refused password explains that changing it in `.env` does not change it in an existing database, and how to set it.
- The production `docker-compose.yml` shows the server's health check, so tools that read the compose file show it too. The check itself is unchanged.
- Adding a worker is one file: Add a Worker gives a `docker-compose.yml` with the server address and the pairing token in it, to save in an empty folder on the n8n host and start with `docker compose up -d`. There are no commands to run and no `.env` or Docker group to fill in: the worker image hands `./data` to its user and, without the socket proxy, joins the Docker socket's group by itself, and the socket proxy runs as root with no capabilities to open the socket. The worker image is pinned to the server's version instead of `latest`.

### Fixed

- `scripts/verify.sh --changed` (and the CI of pull requests) no longer builds the web app twice at once when a file at the root such as `CHANGELOG.md` changed, which could fail the build at random.
- Add a Worker accepts any name up to 60 characters, such as "Docker Office". Before, a name with a space was refused with a technical pattern message. A refused value in the dialog is now explained in words.
- The commands Add a Worker gave wrote `.env` with `cat >`, which replaced any `.env` already in that folder.

## [0.1.0] - 2026-10-22

### Added

- **Failure monitoring.** Reads every instance's failed executions and groups them into problems, one per workflow, node and exact error, with the full stored execution. Regressions, auto-resolve, mute, merge and retention; the first sync is silent.
- **Alerts and reports.** One Telegram alert per problem, with Resolved and Mute buttons; several workflows failing with the same error become one message, which later problems edit instead of repeating. Alerts when an instance or a queue worker goes down and when it recovers, when a queue backlog lasts, and when a backup fails or is overdue. Daily and weekly email reports that read on phones, in dark mode and in Outlook.
- **Health.** Main processes, queue workers and queue backlog, checked from n8n-ops or from inside the n8n host.
- **Instances.** Registration with a connection test. The API key's scopes, read from n8n 2.14 and later or declared on older versions, turn features on and off. A version check against the latest n8n release.
- **Backups.** Workflows and credential secrets, encrypted with your public key before they leave the n8n host, verified in S3-compatible storage, scheduled per instance with daily, weekly and monthly retention, and a nightly backup of the n8n-ops database. Restore of a single workflow with its credentials, and export of decrypted credentials as an encrypted file.
- **Workflows and consolidation.** A map of every workflow on every instance with run counts, duplicates and almost unused instances. Moving a workflow with its credentials after a review of what will change for webhooks and Execute Workflow nodes.
- **Agents.** A read-only MCP server at `/mcp` and a REST API at `/api/v1`, with workflow search by name, ID, webhook path and tag. Agents connect by approval: an MCP client needs only the address, a script gets a link and a code, and agents that run commands install the n8n-ops skill with one sentence (it needs only Node, Windows PowerShell, or sh and curl). Short-lived access tokens, refresh tokens replaced on every use, and Disconnect on the Connected Agents page.
- **Temporary access to n8n instances.** An agent asks for scopes, optional workflows and minutes; you approve in Telegram, by email or on the Agent Access page. The agent then uses the n8n API through n8n-ops, which checks every call against the scopes n8n declares and records it. Access ends on time, on release or on revoke.
- **Worker** for n8n Docker hosts, for credential secrets in backups, moves with credentials and health from inside the host. It pairs with a one-time token and only makes outbound requests. Workers → Add worker gives a ready compose file in which a Docker socket proxy allows only `exec` in the listed n8n containers.
- **Sign-in and audit.** Username, password and mandatory two-factor authentication; a first-run setup for the account, two-factor, the backup key pair, Telegram and storage; a `reset-password` command for the server container. An audit log of sign-ins, changes and agent reads.
- **Interface.** Live updates; two designs for the whole installation, Regular and Compact, with the same functions; light, dark or system theme; one search for pages, settings, problems, instances and workflows; lists beside a reading pane; layouts for phones.
- **Deployment.** Images on GHCR (`n8n-ops` and `n8n-ops-worker`) and a production `docker-compose.yml` behind Traefik that asks only for the version, the domain and the database password. Every container runs as a non-root user with no extra privileges.
