# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Compact now has the functions that were only in Regular: Recent activity on the Overview, Open n8n on an instance, links to backup storage and the backup key when backups are not set up, and Ctrl+B (Cmd+B on a Mac) to fold the sidebar.
- A second design to choose in Settings → General → Design, for the whole installation: **Compact**, the v3 design language, beside **Regular** (the default, unchanged). Compact fits more on each screen: a top bar with where you are and one search for pages, settings, problems, instances and workflows ("/" to start); sortable tables that turn into cards where they are narrow; named filter pickers with a count and Clear filters; a reading pane from 1000px; bottom sheets on phones that grow as they scroll and close when pulled down; Back closing the dialog on top; one save bar that counts unsaved changes and asks before leaving; stored secrets shown as Stored with Replace and Remove; toasts with an icon and a close button. Switching reloads the page into the other design.
- A refined UI: status pills with icons, figures that roll in, empty states that say what to do, a Recent activity feed on the Overview, grouped settings navigation, an audit log that reads at a glance, and cleaner tables in light and dark.
- Temporary access for agents to n8n instances: a token allowed to ask requests an instance, scopes, optional workflows and minutes; a person approves on the new Agent access page; the agent uses the n8n API through the n8n-ops proxy, which checks every call against n8n's declared scopes and records it, and access ends on time, on release or on revoke.
- Access requests reach approvers in Telegram (Approve and Deny buttons, limited to listed approvers) and by email (a link to the request); the Telegram message shows the outcome once decided, expired or ended.
- Workflow search for agents by workflow ID, webhook path and tag, with whether access to the instance can be requested.
- Worker behind a Docker socket proxy (on by default when adding a worker): only `wollomatic/socket-proxy` sees the socket and allows exec only in the listed n8n containers. Add worker now gives a ready docker-compose.yml.
- Theme choice (light, dark or system) in the account menu.
- Read-only MCP server at `/mcp` and REST API at `/api/v1` for agents, with scoped tokens and MCP reads in the audit log.
- Live updates in the UI through server-sent events; problem and list pages take the full screen on phones.
- Logins in the audit log; workflow counts on the instance page; a finish-setup reminder on the Overview.
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

### Changed

- Every email (the daily and weekly reports, the test email and agent access requests) uses the console's v3 layout: a headline that says what happened, key figures, tinted panels with tables, status tags, and one button to act. It follows dark mode where the mail app does, reads on phones, and is built from tables, so Outlook for Windows keeps the layout. Dates read day/month/year in the time zone set in Settings → General. Messages are sent base64-encoded, so no mail server can break a long line inside the HTML, and addresses keep the colour of the text around them.

### Fixed

- Compact: agent access settings on an instance keep unsaved changes when the page refreshes its data, and show a change made elsewhere when nothing is unsaved.
- Links in alerts, the Telegram webhook and worker install commands use `N8N_OPS_PUBLIC_URL` when Settings leaves the public URL empty; behind a TLS proxy they were built with http.
