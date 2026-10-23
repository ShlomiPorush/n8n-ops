# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Backup destinations.** Backups can go to several places at once: S3-compatible storage, a folder on the host (mapped to `/backups` in the server container), SFTP and WebDAV (HTTPS). Every copy is read back, or checked by the service, against the archive's size and SHA-256 before it counts. Each destination is tested before it is saved, has its own daily, weekly and monthly retention, can be the default and can be turned off. Settings → Backup Destinations.
- **Destinations per instance.** Each instance backs up to the default destinations, following them as they change, or to the ones chosen on its page. The nightly backup of the n8n-ops database has its own choice.
- **Object Lock for S3.** An S3 destination can lock every archive it writes for a number of days (Compliance or Governance mode), so nobody can delete it early, not even with its keys. Retention removes an archive only after its lock ends.
- Alerts and the Overview now say which destination a failed or overdue backup is about. The history of each backup shows every copy: where it is, whether it was written, and why not.

### Changed

- **Backup Storage became Backup Destinations.** On upgrade, the S3 storage becomes the first destination with every archive written so far. Retention moves from the instances to the destinations: the S3 destination keeps, for each of daily, weekly and monthly, the largest number any instance kept, so no archive is removed earlier than before; the previous values are in the audit log. Lower them on the destination if you want to.
- The worker now sends the encrypted archive to the n8n-ops server, which writes the copies; the archive stays encrypted with your public key all the way. Workers already installed keep working without an update.
- The production `docker-compose.yml` maps `./backups` to `/backups` for folder destinations. Add the line to an existing compose file to use them.
- The setup's last step adds the first backup destination (S3 or the folder) instead of S3 storage.
- **The page of an instance has tabs:** Overview, Problems, Health, Backups, Access and Settings. The Overview shows on one screen whether the instance is fine: its health checks in one line, open problems, workflows, executions and the last backup run, and the three problems seen most recently. Each tab has its own address (`?tab=health`). Edits on several tabs are kept while switching and saved together, and a tab with unsaved changes is marked. Export credentials and Remove moved into the menu beside Edit. The open problems are listed as items, so nothing scrolls sideways. The tabs share the full width; in a narrow pane each shows its icon over its name, so all six fit. On a phone they are a bar at the bottom of the sheet, like the app's own tab bar.
- On a phone or a small tablet, the save bar of a page opened as a sheet (an instance, for example) shows inside the sheet, where it can be reached.
- **The page of a problem has tabs too:** Overview, Input, Occurrences and Same error (only when other workflows have the same error). The Overview shows the failures, when it was first and last seen, where in the workflow it broke and which run failed last. The runs are listed as items, and Merge into… moved into the menu beside Open in n8n.
- On a phone, an item opened from a list (an instance, a problem, a backup) opens in a sheet of four fifths of the screen whatever it holds, so it no longer changes size as you switch tabs.
- **Typed work is not dropped without asking.** A dialog you typed in (Add or Edit instance, a backup destination, Add a Worker, New Token, Restore, Move) asks "Discard your changes?" before Cancel, Close, Escape, Back or pulling the phone sheet down throws them away. Keep editing is the first choice, so Enter keeps the work; after a save the dialog closes without asking.
- **Settings keeps your changes across its sections.** Moving to another section no longer asks: each section with unsaved changes gets a dot in the list (and "(unsaved)" in the picker on narrow screens), one save bar counts every change, Save changes saves every changed section and Discard drops them all. Leaving Settings still asks.

- When the server cannot sign in to PostgreSQL or reach it at startup, it says why in one line and what to do, instead of a stack trace. A refused password explains that changing it in `.env` does not change it in an existing database, and how to set it.
- The production `docker-compose.yml` shows the server's health check, so tools that read the compose file show it too. The check itself is unchanged.
- Adding a worker is one file: Add a Worker gives a `docker-compose.yml` with the server address and the pairing token in it, to save in an empty folder on the n8n host and start with `docker compose up -d`. There are no commands to run and no `.env` or Docker group to fill in: the worker image hands `./data` to its user and, without the socket proxy, joins the Docker socket's group by itself, and the socket proxy runs as root with no capabilities to open the socket. The worker image is pinned to the server's version instead of `latest`.

### Fixed

- Clicking a tab (Connected Agents, for example) no longer leaves a focus ring around it, cut off at the top and bottom. The ring still shows, whole, when the tabs are used with the keyboard.
- **The SMTP password is no longer sent to a new SMTP server.** Changing the SMTP server, port or user in Settings → Email Reports now needs the password again; before, the stored password was used to sign in to whatever server was entered next.
- What is typed in Edit instance is no longer replaced by the stored values when the instance refreshes behind the dialog (every 15 seconds, or on coming back to the window).
- "Leave without saving?" now starts on Stay, so pressing Enter keeps your changes, and it no longer adds a step to the browser's history.
- Log out with unsaved changes asks first, before the session ends. If signing out fails, it says "Could not sign out. Try again in a moment." and the changes stay.
- When your session ends on an open page, the page now goes to sign-in and brings you back to it afterwards, instead of showing errors.
- When one area of a save fails and another is saved, the message now names what failed and why; before, the success message could replace it. The failed area keeps its changes.
- After Add instance or Merge, Back goes to the page the dialog was opened on in one step, instead of first returning to an empty step of the closed dialog.
- The line under a row of tabs that scrolls sideways now runs to its end at any scroll position.
- **A failed refresh no longer empties the page.** When a list, an open item or a Settings form cannot be refreshed (during a server restart, for example), what was loaded stays on screen and the line under the title reads "Could not refresh · Updated 4 min ago" in amber, with Try again. It clears with the next good answer. Before, the rows or the form were replaced by an error until then.
- The audit log keeps every entry already loaded when older entries fail to load, and says so at the end of the list with Try again. Before, the whole log was replaced by an error, after asking twice more on its own.
- Show full execution on a problem says why the execution could not be loaded, instead of showing the error as JSON. Closing the window while it loads no longer opens it again when the answer arrives.
- The search still finds the instances already loaded when the last refresh of the instance list failed, instead of saying it could not search them.
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
