# n8n-ops: Requirements (v1)

Status: approved v1 product requirements (2026-10-14), implemented and verified in the test stack; not yet released. See [project-foundation.md](project-foundation.md) for what exists.

Environment-specific details (instance names, hosts, local paths) are kept in `docs/private/`, which is not tracked.

## 1. Goal

One place to operate all of our n8n instances:

- Replace the tens of error emails per day (currently deleted unread) with a small number of meaningful alerts.
- Give an AI agent an API that returns the full picture of a failure, not only "something failed".
- Reliable, encrypted, off-site backups of workflows and credentials, with tested restore.
- Make it easy to move workflows between instances and consolidate the 16 instances into a few.

## 2. Target environment

The first deployment target is 16 self-hosted n8n instances on one Docker host, each with its own PostgreSQL database and the public API enabled. Exactly one instance runs in queue mode. Today their failures produce tens of error emails per day, which are deleted because of volume. The current n8n release is 2.44.0 (2026-10-13).

The product is generic and must not depend on the details of this environment. Versions, pruning settings and which endpoints are reachable are configuration, read at registration time or set by the operator. `scripts/discover.sh` helps an operator collect them during installation.

## 3. Verified facts about n8n (checked against n8n 2.44.0 source, not against a live instance)

- `GET /api/v1/executions?status=error&includeData=true` returns the error details (`resultData.error`) on the list endpoint. No per-execution fetch is needed for the basics. Large data is cut at `EXECUTIONS_DATA_MAX_DISPLAY_SIZE` unless `ignoreDataSizeLimit=true`.
- The public API never returns credential secret values, encrypted or decrypted. It returns name, type and ID only. `POST /credentials` accepts plaintext values, so restore through the API works if the values come from elsewhere.
- `N8N_ENCRYPTION_KEY` is not available through any API.
- There is no export or backup endpoint. `export:workflow`, `export:credentials --decrypted` and `export:entities` are CLI only and run on the host.
- `GET /api/v1/discover` (since n8n 2.14.0, released 2026-03-24) returns the calling API key's scopes.
- API key scopes are available without an Enterprise license since 2.14.0 (the docs still say Enterprise only).
- There is no supported way to embed n8n's own canvas with real run data without the viewer being logged in to n8n and the instance being reconfigured. n8n-ops draws its own simple workflow view.

## 4. Architecture

- **Language:** TypeScript.
- **Database:** PostgreSQL. Failed executions are stored in full and must be searchable (JSONB).
- **Deployment:** Docker Compose. `server` can run on any host that can reach the instances; it does not have to run next to n8n. Running it elsewhere means it can still alert when the n8n host itself is down.
- **Components:**
  - `server`: UI, REST API, MCP server, pollers, alerting, scheduler. No Docker socket.
  - `worker` (optional, at most one per Docker host): the only component with the Docker socket. It opens an outbound HTTPS connection to `server`, pulls jobs and reports results. It has no inbound ports. Each instance is assigned to at most one worker.
- **Worker pairing:** "Add worker" in the UI creates a one-time pairing token (expires in 15 minutes). The worker exchanges it for a permanent identity; the token is then invalid. Every worker is listed with status and last seen, and can be revoked.
- **Two operating modes:**
  - **API only (no worker):** monitoring, problems, MCP, workflow map, workflow backups, and moves where credentials are recreated empty. The UI states clearly that credential secrets are not backed up.
  - **With worker:** adds credential secrets in backups, moving workflows with their credentials, and exporting decrypted credentials.

## 5. UI

- **English only, LTR only.** No Hebrew, no RTL, no localization layer, no language setting.
- **Component library:** shadcn/ui with the classic **Vega** style, Tailwind CSS, lucide icons. Default neutral color scheme. Light and dark themes.
- **Layout (prototype variant D):**
  - shadcn Sidebar (inset, collapsible to icons) with breadcrumb header and user menu.
  - Home (Overview): stat cards, a "needs attention" table, and a tile per instance colored by health.
  - Problems, Instances, Backups: a full-width table for an overview at a glance. Clicking a row opens a resizable detail panel beside the table (not an overlay); the table stays visible with the row highlighted, and the panel closes back to the full table.
  - Workflows: table with insights; moving a workflow opens a dialog wizard.
  - Settings: tabs. Workers and Audit log: own pages.
- **Problem page:** workflow, node, error text, counter, first and last seen; actions Mark resolved, Mute 24 h, Open in n8n (deep link to the execution). A drawn workflow graph with the failed node highlighted, the failed node's input as a key/value table (raw JSON on demand), recent occurrences, and other workflows with the same error.
- **Live updates:** pages update by themselves (server-sent events).
- **Mobile:** home and problem page are designed mobile first (Telegram links open there). Other pages work on mobile but are designed for desktop.
- **Heavy actions** (move, restore): one review screen that lists what will happen, then one confirm button. No typed confirmation or extra password. Result and verification are shown after, and the action is audited.
- A throwaway UI prototype of this layout exists outside the repository (location in `docs/private/`). It is a reference for the look and flow only; its code is not to be reused as production code.

## 6. v1 scope

v1 includes all of A to G except the items listed under "Not in v1". Build order inside v1 is Shlomi's call.

### A. Instances

- **A1** Register an instance: name, base URL, API key (encrypted at rest), mode (regular or queue), main and worker endpoints, assigned worker (optional).
- **A3** Instance card: n8n version, active and total workflows, executions in 30 days, open problems, last backup, queue metrics (queue instance), overrides.
- **A4** Periodic API key check. On registration and on every check, read the key's scopes from `GET /api/v1/discover` and turn features on or off to match. Changes in scopes are shown in the UI and written to the audit log. On n8n older than 2.14.0 the user declares the key as "read only" or "read + write".
- **A5** For each feature, the UI and the docs list the exact scopes it needs (table built from the n8n source, not from memory). Features whose scopes are missing are shown as unavailable with the missing scopes.

### B. Errors

- **B1** Poll `GET /api/v1/executions?status=error&includeData=true` on every instance. Chosen over Error Workflows because those must be set on each workflow and any workflow without one would be missed. Polling needs no change to the instances.
- **B2** Extract: failing node, error message, stack, the failing node's input, workflow name and version, trigger type.
- **B3** Group failures into **problems** by fingerprint: instance + workflow + node + **exact** error text. Each problem tracks count, first seen, last seen. The UI allows merging problems manually.
- **B4** Store each failed execution in full before n8n prunes it, encrypted at rest and searchable. Retention is configurable globally and per instance (default 30 days). Poll interval must be shorter than each instance's `EXECUTIONS_DATA_MAX_AGE`.
- **B5 (basic)** Problem states: open, resolved, muted. Resolved automatically after N days without failures (default 7), manually in the UI, or with the Telegram button. A failure after resolved is a regression.
- **B6** First sync of each instance is silent: existing failures are imported without alerts and appear in the UI and the first report.
- **B7** Notifications, see section 7.

### C. Health and queue

- **C1** Health of every main and every queue worker (`/healthz`, `/healthz/readiness`). Endpoints are polled directly when `server` can reach them; when they are only reachable on the n8n host, the n8n-ops `worker` on that host collects them and reports to `server`. Both paths are supported; the choice is per instance.
- **C2** Queue metrics from the queue instance `/metrics`: jobs waiting, active, completed, failed; which workers are alive. Same direct-or-worker collection as C1.
- **C3** Alerts: instance not responding, worker down, queue backlog above threshold for longer than N minutes.
- **C4** Version of each instance compared with the latest n8n release, including which instances are below 2.14.0.

### D. Backups

Workflow-level only in v1. Full-instance backup (`pg_dump` plus `N8N_ENCRYPTION_KEY`) is out of v1; Shlomi already has another tool for it.

- **D1** Per instance, on a schedule: export workflows, and with a worker, `export:credentials --decrypted` through `docker exec`. Decrypted credentials are kept on purpose so they can be moved to systems other than n8n.
- **D2** Every archive is encrypted with **age** on the host where it is produced, using a public key. If no key is configured the job fails; there is never an unencrypted fallback. Keys never appear on a command line or in the repository.
- **D3** Each instance is backed up independently; one failure never stops the others. Status, size, counts and history are stored per instance.
- **D4** Retention (default 7 daily, 4 weekly, 6 monthly), configurable globally and per instance.
- **D5** Upload to S3-compatible storage, verified (size and checksum). The provider is configuration only.
- **D6** Restore one workflow with its credentials into the same instance (as an inactive copy) or another instance. The private key is pasted at restore time, used in memory, and never stored. Tested in a scratch container before v1 is accepted.
- **D7** Alert when a backup fails or the last successful backup is older than a threshold (default 26 h).
- **D8** n8n-ops backs up its own database nightly to the same S3 storage, encrypted with the same age key.

### E. API and agent

- **E1** REST API with tokens.
- **E2** MCP server: list open problems, problem details, full failed execution, instance health, queue status, backup status, search workflows across all instances.
- **E3** Read only in v1, except E4.
- **E4** Temporary access to n8n instances (added after v1 was implemented). A token allowed to ask requests an instance, a reason, scopes, optional workflow IDs and a duration. Settings decide which instances are open, which scopes may be granted on each (never beyond the instance's API key) and the longest duration. A person approves each request: in the UI, by Telegram button (only listed approvers, or the user of a private chat), or through the link in an email. The agent never receives an n8n key: it calls the n8n public API through an n8n-ops proxy with a temporary key, and n8n-ops checks every call against the scopes n8n declares per operation and the approved workflows, forwards it with the instance's key and records it. Access ends on time, on release by the agent, or on revoke. Agents can find which instance holds a workflow by name, ID, webhook path or tag, but only need to when the instance is not already known.

### F. Consolidation

- **F1** Map of all workflows on all instances: active state, trigger, webhook path or schedule, last run, runs in 30 days, error rate.
- **F2** Duplicates: same structure (same node types and connections, names may differ). Almost unused instance: no executions in 30 days or no active workflow. Shown only; no automatic action.
- **F3** Move a workflow with its credentials to another instance. Before every move the review screen shows: webhook URL changes, Execute Workflow nodes that reference workflows left behind, credentials that will be created. Order: create on target, verify, then deactivate the source. Nothing is deleted. Without a worker, credentials are created empty.

### G. System

- **G1** One local user, built on a ready-made auth library (Better Auth): password plus **mandatory TOTP**, lockout after repeated failures, password reset from the server CLI only.
- **G2** Audit log: logins, settings changes, scope changes, restores, moves, exports, worker pairing, Telegram button presses, MCP reads.
- **G3** English, LTR, light and dark themes.
- **G4** Settings in the UI: alerts, Telegram, email reports, backup storage, keys, instance defaults, account, API and MCP tokens. Instance-related settings (backup schedule and retention, poll interval, alert thresholds, auto-resolve days) have a global default with per-instance override. SMTP, Telegram and S3 are global only.
- **G5** First-run setup wizard: account and TOTP, backup key pair (private key shown once, must confirm it was saved), then Telegram, storage and first instance (these three can be skipped and finished later; home shows what is missing).

### Not in v1

- **A2** Automatic discovery of new containers.
- Full-instance backup and restore (`pg_dump`).
- Problem notes.
- Write actions through REST or MCP.

## 7. Alerts

The system must not recreate the inbox that is deleted today. This is a hard requirement.

**Telegram (real time), only for:**

1. A new problem.
2. A regression.
3. Instance not responding, worker down, queue backlog (C3).
4. Backup failed or stale (D7).

**Rules:**

- Each problem alerts once. Further failures only increase its counter.
- New problems are held for a grouping window (default 2 minutes). New problems with the same error text in that window go out as one message listing all affected workflows.
- A workflow that later fails with the same error text, while the original message is less than 60 minutes old, **edits** the original message (for example "8 workflows affected") instead of sending a new one.
- Health and worker alerts are sent immediately, without a window.
- Messages are queued in the database and retried every 5 minutes on failure, respecting Telegram's `retry_after`. There is no hourly cap.
- Messages have buttons "Resolved" and "Mute 24 h". Telegram calls n8n-ops by webhook, verified with the secret-token header, and presses are accepted only from the configured chat. Every press is audited.
- The chat ID is configuration.

**Email (reports):** daily and weekly report with open problems by instance, top failing workflows, health incidents, backup status, version drift. Schedule configurable.

Everything else is visible only in the UI and the API.

## 8. Security and data handling

- The UI is reachable from the internet behind a reverse proxy with TLS or behind Cloudflare Access. Login requires TOTP.
- Secrets (instance API keys, SMTP, Telegram token, S3 keys) are encrypted at rest with an app key generated in the UI on first run and stored in a file in the data volume. Not in environment variables, not in the repository.
- Backups use age with a public key on the server; the private key exists only with Shlomi (password manager). An attacker on the server cannot read any archive.
- Failed executions may contain customer data: encrypted at rest, retention limited.
- The worker is the only component with the Docker socket and has no inbound ports.
- API keys for n8n are read-only by default. Write scopes are optional and enable only the features that need them.
- The repository is public: no environment-specific names, addresses or secrets in it.

## 9. Prerequisites on production instances

These change and restart production containers. They are Shlomi's call and are done by him or with his explicit approval.

- Queue instance main: `N8N_METRICS=true`, `N8N_METRICS_INCLUDE_QUEUE_METRICS=true`.
- Queue instance workers: `QUEUE_HEALTH_CHECK_ACTIVE=true`.
- One API key per instance for n8n-ops (read only, plus write scopes where moves or restores are wanted).
- Turning off the old error emails, after a period of running in parallel: Shlomi.

## 10. Open items

1. **Scope table per feature (A5):** to be built from the n8n source during implementation.

## 11. Acceptance for v1

- All 16 instances registered and polled; failures grouped into problems; first sync silent.
- Telegram receives only the events in section 7, with grouping and message edits working; buttons work.
- Daily email report arrives.
- An agent can retrieve full failure details through MCP.
- Backups of all instances land encrypted in S3; one single-workflow restore is performed in a scratch container and verified.
- One workflow is moved between two instances in a test and verified.
- Login with TOTP works; the setup wizard works on a fresh install.
