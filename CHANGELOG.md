# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Worker for n8n Docker hosts: pairs with a one-time token, outbound only, runs n8n's CLI through the Docker socket; health collection on the host for endpoints the server cannot reach.
- Backups: workflows and decrypted credentials through the worker (workflows and credential names through the API without one), age-encrypted before upload, verified in S3-compatible storage, scheduled per instance with daily/weekly/monthly retention, stale and failure alerts, nightly backup of the n8n-ops database.
- Restore of one workflow with its credentials from an archive with the private key; export of decrypted credentials as an age-encrypted file.
- Workflow map across instances with run counts, duplicate detection and almost-unused instances; moving a workflow with its credentials, with a review of webhook and Execute Workflow consequences.
- Sign-in with username, password and mandatory TOTP (Better Auth); first-run setup wizard (account, two-factor, backup key pair, Telegram, storage); `reset-password` command in the server container.
- Instance registration with a connection test; API key scopes read from n8n `/discover` (or declared on n8n older than 2.14) turn features on and off; version check against the latest n8n release.
- Failure monitoring: polls error executions, groups them into problems (workflow + node + exact error), stores full executions, silent first sync, regressions, auto-resolve, mute, merge, retention.
- Health and queue checks for main processes and queue workers, with alerts when an instance or worker goes down or a backlog lasts.
- Telegram alerts with grouping, message edits instead of repeats, Resolved and Mute buttons, retries; daily and weekly email reports.
- Overview, Problems and Instances pages; a disposable n8n 2.44 in the development and test stack.
- Application shell (sidebar layout), settings with per-instance defaults, encryption keys, API and MCP tokens, audit log.
- Project foundation: pnpm workspace with `server`, `web`, `worker` and `shared`, container images, development stack, workflow scripts, CI and Dependabot.
