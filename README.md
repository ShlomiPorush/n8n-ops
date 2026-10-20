# n8n-ops

An operations console for teams that run many self-hosted n8n instances.

- **Failures without the inbox.** Reads every instance's failed executions, groups them into problems (one per workflow, node and error) and sends one Telegram alert per problem. Several workflows failing with the same error become one message, which later failures edit instead of repeating. Daily and weekly email reports cover the rest.
- **Health.** Main processes, queue workers and queue backlog, with an alert when something goes down and when it recovers.
- **Agents.** A read-only MCP server and REST API return the full picture of a failure: the failed node, its input, the stack and the stored execution.
- **Backups.** Workflows and credential secrets, encrypted on the n8n host with your public key, verified in S3-compatible storage, with retention and a tested restore of single workflows.
- **Consolidation.** A map of every workflow on every instance, duplicates, almost unused instances, and moving a workflow with its credentials after a review of what will change.

Requirements and design: [docs/requirements.md](docs/requirements.md). How the repository works: [docs/project-foundation.md](docs/project-foundation.md).

## Install

Requirements: Docker with Compose, a host that can reach your n8n instances, and an HTTPS reverse proxy (or Cloudflare Access) in front of n8n-ops.

```bash
curl -O https://raw.githubusercontent.com/ShlomiPorush/n8n-ops/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/ShlomiPorush/n8n-ops/main/.env.example
# Edit .env: N8N_OPS_PUBLIC_URL, passwords, data directory.
mkdir -p /srv/n8n-ops/server /srv/n8n-ops/postgres && chown 1000:1000 /srv/n8n-ops/server
docker compose up -d
```

Open the public URL. The first visit runs the setup: your account, two-factor authentication (required), and the backup key pair. **Save the private backup key** when it is shown; without it no backup can be restored. Telegram and storage can be set then or later in Settings.

`N8N_OPS_PUBLIC_URL` must be the HTTPS address users open. It enables secure cookies, is trusted for sign-in, and is used in links sent by Telegram and email.

The compose file pulls `ghcr.io/shlomiporush/n8n-ops` images, which `scripts/release.sh` publishes. **No release has been published yet**, so this works from the first release on.

## Add n8n instances

In each n8n instance: Settings → n8n API → create an API key. "Read only" is enough to monitor; moving and restoring workflows also needs `workflow:create`, `workflow:activate` and `credential:create`. n8n-ops reads the key's scopes (n8n 2.14 or later) and turns features on or off to match.

For a queue-mode instance, set `N8N_METRICS=true` and `N8N_METRICS_INCLUDE_QUEUE_METRICS=true` on the main process and `QUEUE_HEALTH_CHECK_ACTIVE=true` on the workers, then add the metrics and worker health URLs.

## The worker (optional, one per n8n Docker host)

Without a worker, backups contain workflows and credential names but not credential secrets. With one, backups include decrypted credentials (encrypted with your key before they leave the host), moves copy credentials, and health can be checked from inside the host.

Workers → Add worker gives a one-time token, the commands to run on the host and a `docker-compose.yml`. The worker runs as UID 1000 and only makes outbound HTTPS requests; it opens no ports. Then assign it to the instance and set the n8n container name.

**Docker socket proxy (recommended, on by default).** The worker needs Docker only to run n8n's CLI inside the n8n containers. With the proxy, the worker gets no Docker socket: [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy) holds the socket, reachable only by the worker on an internal network, and allows ping and `exec` in the containers you list, nothing else. List container names, or use `*` to cover containers added later (for example `n8n*`); with a plain list, add a new container to `-allowPOST` in the compose file and run `docker compose up -d`. Without the proxy, the worker mounts the socket and has full control of Docker on the host.

## Agents

Agents connect by approval: nothing to create or paste by hand. Set the public URL in Settings → General first; the Connected agents page lists every connected agent with **Disconnect**.

- **MCP clients** (Claude Code, Cursor and others): add `https://<your n8n-ops>/mcp` as an MCP server, for example `claude mcp add --transport http n8n-ops https://<your n8n-ops>/mcp`. The client opens n8n-ops in the browser; you sign in, see who asks, where the browser returns to and what it may do, untick what it should not get, and approve. Standard MCP authorization (OAuth 2.1 with PKCE; the client registers itself).
- **Agents that run commands** (T3 Code, Claude Code, Codex and others, including those whose host app cannot sign in to an MCP server): Connected agents → Coding agent gives one sentence to paste to the agent. It installs the n8n-ops skill from `https://<your n8n-ops>/connect/skill/` (needs an https public URL) and shows you a link and a code; you compare the code and approve. The skill's command, `n8n-ops`, then keeps the connection and calls the REST API: `n8n-ops get 'problems?status=open'`, `n8n-ops post access-requests --json-file body.json`, `n8n-ops status`, `n8n-ops disconnect`. It needs nothing installed: it uses Node 20+ when there is one, otherwise Windows PowerShell on Windows, or sh and curl on Linux and macOS. Each place the skill is installed is its own agent, named after the agent and the computer (for example `Claude Code (.claude-ai2) on PC-1`), with its own approval and Disconnect; its sessions share it.

  The command keeps the connection in `%APPDATA%\n8n-ops\` (Windows) or `~/.config/n8n-ops/` (elsewhere), in files only your user can open; it refuses a folder or file others can read rather than fixing it silently. That protects the tokens from other users of the computer, not from other programs running as you. Tokens never appear in its output or on a command line. It talks to n8n-ops over https only (http only to the same computer) and follows no redirects. Concurrent commands share one refresh under a lock, so parallel agent calls never use a refresh token twice; if a refresh gets no answer, the next command tries the same token once more, which either continues the connection or ends it (and with it any instance access it holds at that moment).
- **Scripts** (device code, RFC 8628): ask for a code, show the link, wait for the approval, then use the tokens. Send `client_label=<a name>` with the code request to name the connection.

  ```bash
  curl -s https://<your n8n-ops>/oauth/device -d client_id=n8n-ops-cli \
    -d resource=https://<your n8n-ops>/api/v1 -d "scope=ops:read offline_access"
  # → user_code, verification_uri_complete, device_code, interval. Open the link: compare the code, approve.
  curl -s https://<your n8n-ops>/oauth/token -d client_id=n8n-ops-cli \
    -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=<device_code>
  # Every <interval> seconds until it answers with access_token and refresh_token.
  ```

- **What a connection holds**: an access token good for 15 minutes and for one resource only (`/mcp` or `/api/v1`), and a refresh token that is replaced on every use (`grant_type=refresh_token`). A refresh token used a second time ends the connection, since a copy is out. A connection lasts until you disconnect it and ends by itself after 90 days without use, or when the public URL changes. Scopes: `ops:read` (always) and `ops:access` (may ask for temporary access to n8n instances, below).
- **A token made by hand** stays on Connected agents, under Advanced → New token, for a program that cannot open the approval link. It lasts until revoked.

- **MCP** (Streamable HTTP): `https://<your n8n-ops>/mcp` with the header `Authorization: Bearer <access token>`. Tools: `list_open_problems`, `get_problem`, `get_failed_execution`, `get_instance_health`, `get_queue_status`, `get_backup_status`, `search_workflows` (by name, workflow ID, webhook path or tag; each result says whether access to its instance can be requested).
- **REST**: `GET /api/v1/problems`, `/api/v1/problems/{id}`, `/api/v1/problems/{id}/execution`, `/api/v1/instances`, `/api/v1/queues`, `/api/v1/backups`, `/api/v1/workflows?q=` with `Authorization: Bearer <access token>`.

### Temporary access to n8n instances

An agent that needs to change something in n8n asks n8n-ops instead of holding an n8n API key:

1. On each instance, **Agent access** says whether agents may ask, and which scopes may ever be granted (never more than the instance's API key holds). Settings → Agent access sets the longest access and how long a request waits.
2. The agent calls `request_instance_access` (MCP) or `POST /api/v1/access-requests` (REST) with the instance, a reason, the scopes, optionally the workflow IDs, and the minutes it needs.
3. You approve or deny it: with the **Approve** and **Deny** buttons on the Telegram message, from the link in the email, or on the **Agent access** page (also under Needs attention on the Overview). In Telegram only the approvers listed in Settings → Agent access can decide; with none listed, only you in a private chat with the bot. The message then shows the outcome.
4. The agent collects the key once with `get_access_request` (`GET /api/v1/access-requests/{id}`) and calls the n8n public API at `https://<your n8n-ops>/n8n/<instance>/api/v1` with the key in `X-N8N-API-KEY`, so n8n API clients work by changing only the base URL.
5. n8n-ops checks every call against the scopes n8n declares for each operation (n8n 2.14 or later) and, when workflow IDs were given, against those workflows; then it forwards the call with the instance's own key and records it on the request.
6. Access ends when its time is up, when the agent calls `release_instance_access` (`POST /api/v1/access-requests/{id}/release`), or when you revoke it. Disconnecting the agent revokes its access too.

## Locked out

```bash
docker compose exec server node dist/cli.js reset-password
```

It prints a new password and turns two-factor off until you sign in and set it up again.

## Development

Requirements: WSL (or Linux) with Docker. Node.js and pnpm run in a container.

```bash
cp docker/docker-compose-dev.example.yml docker-compose-dev.yml   # once per machine
scripts/local.sh start     # server, PostgreSQL, worker, a disposable n8n, S3Mock and Mailpit on http://localhost:8080
scripts/verify.sh          # everything CI checks, including end-to-end tests against real n8n
```

`scripts/discover.sh` is a read-only helper that inventories an n8n Docker host (containers, versions, environment with secrets masked) for planning an installation.

## License

[MIT](LICENSE)
