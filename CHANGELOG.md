# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- New look throughout, in the v3 design language: the ink is the accent and colour only means status, flat tinted panels instead of bordered cards, dense type with large page titles and key figures, Onest and IBM Plex Mono served by n8n-ops itself. The screen no longer scrolls as a whole; each page scrolls in place under a 240px sidebar, a 72px icon rail up to 1100px, or on phones a top bar with a bottom tab bar and a More sheet.
- From 761px a top bar shows where you are ("Operate › Problems › Sync orders") with the page's actions at its end; the browser tab carries the same name. The sidebar folds into the icon rail and stays folded in this browser. Settings sections open from a menu beside the sidebar item, and below 1024px from a picker at the top of Settings, which reopens on the section last used. Back returns to where a page was scrolled. Pages say how fresh their data is ("Updated 3 min ago").
- One search in the top bar finds pages, settings, problems, instances and workflows; press "/" to start, arrows to move, Tab to switch the kind, Enter to open. A setting opens with its field in view and focused. On phones the search covers the screen.
- Every status (problems, instance health, backups, workers, agent access) takes its words and colour from one table; healthy items stay quiet, problems stand out with a red or amber edge.
- Times follow the time zone set in Settings → General, on a 24-hour clock: the time for today, the date for earlier days, the exact time on hover.
- Counts and key figures link to the list they count; search and filters on Problems, Workflows and Agent access are kept in the address.
- Settings sections sit beside the form; report and backup times are typed as HH:MM. One save bar counts the unsaved changes of the page ("3 unsaved changes"), saves them together, and leaving the page or the tab with unsaved changes asks first. A refresh never overwrites a field being edited.
- A stored secret (bot token, SMTP password, storage key, instance API key) shows "Stored" with Replace and Remove instead of a masked field, and is never sent again unchanged. Changing an instance's base URL asks for its API key again, so the stored key is not sent to a new address.
- Instance IDs, URLs, execution IDs, keys and commands copy with a click.
- From 1000px an opened problem, instance, backup or access request reads in a pane beside the list, and the first item opens by itself. Narrower it opens over the list; on phones every dialog is a bottom sheet that opens at four fifths of the screen, grows as it scrolls, and closes when pulled down. The browser's Back button closes the dialog on top instead of leaving the page.
- Lists sort by any column header, by click or keyboard, with a sort control on phones; where a list is narrow, rows become cards whose values carry their column names. A list that reloads keeps its rows on screen. List filters are named pickers ("Instance: All"), with a count line and Clear filters under them, and fold behind a Filters button on phones.
- Backups without storage or a backup key show what is missing and where to set it instead of Run now buttons; test buttons in Settings say what to save before they can run.
- Removing an instance and revoking a token, a worker or an agent's access ask for confirmation in one shared dialog that names what will happen.
- Toasts show an icon by result, can be closed, and wait while the pointer is on them.
- Sign-in returns to the page that was asked for, can show the typed password, and warns when Caps Lock is on.
- The audit log loads older entries as you scroll.
- With reduced motion requested, the interface has no transitions or animations.

### Added

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

### Fixed

- Links in alerts, the Telegram webhook and worker install commands use `N8N_OPS_PUBLIC_URL` when Settings leaves the public URL empty; behind a TLS proxy they were built with http.
