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

Settings → API & MCP tokens. Tokens are read-only.

- **MCP** (Streamable HTTP): `https://<your n8n-ops>/mcp` with the header `Authorization: Bearer <MCP token>`. Tools: `list_open_problems`, `get_problem`, `get_failed_execution`, `get_instance_health`, `get_queue_status`, `get_backup_status`, `search_workflows`.
- **REST**: `GET /api/v1/problems`, `/api/v1/problems/{id}`, `/api/v1/problems/{id}/execution`, `/api/v1/instances`, `/api/v1/queues`, `/api/v1/backups`, `/api/v1/workflows?q=` with `Authorization: Bearer <REST token>`.

## Locked out

```bash
docker compose exec server node dist/cli.js reset-password
```

It prints a new password and turns two-factor off until you sign in and set it up again.

## Development

Requirements: WSL (or Linux) with Docker. Node.js and pnpm run in a container.

```bash
cp docker/docker-compose-dev.example.yml docker-compose-dev.yml   # once per machine
scripts/local.sh start     # server, PostgreSQL, worker, a disposable n8n and S3Mock on http://localhost:8080
scripts/verify.sh          # everything CI checks, including end-to-end tests against real n8n
```

`scripts/discover.sh` is a read-only helper that inventories an n8n Docker host (containers, versions, environment with secrets masked) for planning an installation.

## License

[MIT](LICENSE)
