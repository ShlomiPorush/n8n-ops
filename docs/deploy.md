# Deploying a release

This document describes what each release publishes for deployment tools, how a running installation moves to a new
release without downtime, and how to update it with downtime when that is not possible.

## Images and tags

The Release workflow publishes two images to GHCR for each release:

| Image | Runs |
|---|---|
| `ghcr.io/shlomiporush/n8n-ops` | The `server` service of `docker-compose.yml` |
| `ghcr.io/shlomiporush/n8n-ops-worker` | A worker on an n8n host, from the compose file that Workers → Add worker generates |

Each image has two tags:

- `X.Y.Z`, for example `0.21.0`. The workflow pushes it only after the CI of the commit it releases passed; the
  release commit on top of it changes only `VERSION` and `CHANGELOG.md`. A tag `X.Y.Z` never moves to another image:
  a release run stops when an image of that version exists and was built from another commit. The image is built
  from the release commit, which has the git tag `vX.Y.Z`.
- `latest`. It moves to the newest release once both images of that release are published.

Pin a deployment to `X.Y.Z` through `VERSION` in `.env`, not to `latest`.

## Labels for zero-downtime rollouts

The server image carries labels that a zero-downtime rollout with docker rollout uses:

| Label | Value |
|---|---|
| `n8n-ops.compose-sha256` | The SHA-256 of `docker-compose.yml` in the release commit |
| `n8n-ops.rollout-from` | The oldest running release this image may run beside |
| `docker-rollout.pre-stop-hook` | `node /app/dist/drain.js`, which docker rollout runs in the old container before it stops it |

`n8n-ops.rollout-from` is the newest release, up to the one being published, whose release notes have an entry that
starts with **Needs downtime.**; when no release has one, it is the release itself. The first release that is safe
to run beside another server has that entry, because the releases before it are not: it is updated with downtime
once, and every later release keeps its version until a release needs downtime again. A tool that reads the label
refuses to run a new server beside a release older than it.

The worker image carries none of these labels.

Check the labels of a release:

```bash
docker image inspect ghcr.io/shlomiporush/n8n-ops:X.Y.Z \
  --format '{{index .Config.Labels "n8n-ops.compose-sha256"}} {{index .Config.Labels "n8n-ops.rollout-from"}}'
```

## What happens while two servers run

During a rollout the old and the new server run together against the same database and data directory, for
seconds to a few minutes. The server is built for that:

- **One leader.** Only one server runs the scheduled work (polling, alerts, reports, backups and their copies,
  retention, history and session cleanup, the Telegram webhook) and the repairs made at start. A PostgreSQL advisory
  lock picks it. A new server serves requests at once and takes the lead about 5 seconds after the old one has
  exited. A server that loses its lock, for example when PostgreSQL restarts, exits at once, and its restart policy
  starts it again.
- **Drain before stop.** Before docker rollout stops the old server, the image's pre-stop hook makes its health check
  fail and waits 45 seconds, so Docker marks it unhealthy and Traefik stops sending it requests. This relies on
  Traefik's Docker provider, which routes only to healthy containers, and on the image's health check timing
  (every 10 seconds, unhealthy after 3 failures). It is timed, not confirmed by Traefik.
- **A stop that finishes its work.** On SIGTERM the server takes no new requests or scheduled work, ends the
  live-update streams (the pages reconnect to the other server), and exits once the requests it accepted and the
  work it started have finished: backup dumps, uploads and copies, restores, moves, compactions. Docker kills it when
  its stop timeout runs out, which is 10 seconds unless `stop_grace_period` sets more. Give the server a
  `stop_grace_period` longer than its longest backup upload, restore, move or compaction. Work cut by the timeout
  recovers as after any restart: a copy is written again by the next leader, a backup run whose archive never
  arrived fails after its wait, and a cut restore is marked unknown.
- **Web assets of both releases.** Each server copies its web assets into `data/web-assets` when it starts and
  serves the other release's assets from there, so a page loaded from either release works through either server.
- **Migrations beside the old release.** The new server migrates the database when it starts while the old one still
  serves. Each migration says whether the old release keeps working on the migrated database (`-- rollout: expand`,
  allowed only for new tables, their indexes and keys between them) or not (`-- rollout: downtime`); a test refuses
  anything else, and a release that adds a `downtime` migration cannot be published without a **Needs downtime.**
  entry. Two servers that start at once apply each migration once.

Accepted behaviours while both servers run:

- Each server keeps its own counters for sign-in and agent-connection rate limits, so more attempts are possible
  until the old one stops; the per-agent "request in progress" guard is per server too (the database still limits
  pending requests). Two archive uploads that reach different servers at once can both pass the free-space check
  and use part of the 1 GiB kept free.
- Live updates reach only the pages connected to the server that made the change; a page connected to the new
  server shows the old one's changes after a reload or once the old server stops.
- A worker answer can reach the other server. A probe or an Add instance check answered there is discarded (run the
  check again); a server that missed a worker's return can accept a result from before it. A credential export or a
  move that waits for such an answer fails with a timeout before anything is written; try it again.
- A Telegram button pressed at that moment can edit an alert message at the same time as the leader. A workflow map
  refresh started by a request can race the leader's; the next refresh corrects it.
- Only when two servers keep running for more than 5 minutes, for example after an interrupted rollout: the leader
  marks a restore confirmed more than 5 minutes ago as unknown, even if the other server is still running it.
- After a server lost its lock and exited, an upload, a Telegram message or a webhook registration it had already
  sent can still complete: a bucket can keep an extra object version, a message can repeat, and Telegram can keep
  an old webhook address until the leader's next check, within a minute.

## What the installation needs

These rules hold for the `docker-compose.yml` and `.env` on the host. The tracked `docker-compose.yml` follows them.

- `name: n8n-ops` at the top of `docker-compose.yml`, so the Compose project name is `n8n-ops`.
- The `server` service uses `image: ghcr.io/shlomiporush/n8n-ops:${VERSION}`.
- `.env` has exactly one `VERSION=X.Y.Z` line.
- The `server` service has no `container_name`, no published port, no `network_mode: host`, no `build` and one
  replica. Requests reach it through Traefik's Docker provider.
- The `server` service keeps the health check of the image (`node dist/healthcheck.js`, every 10 seconds, 3
  retries), or defines the same one.
- A restart policy such as `restart: unless-stopped`, and a `stop_grace_period` as described above.

`scripts/update.sh` rolls a release out with docker rollout only when exactly one healthy server of a release runs,
the new image's `n8n-ops.rollout-from` allows the running release, and the new release is not older than it. Anything
else stops it before `.env` changes; then use the update with downtime.

## Update with downtime

Use it for a release that cannot run beside the running one, for a server that is stopped or missing, and for any
state the rollout refuses. Before an update, make sure that the n8n-ops database backup (Backups → n8n-ops database)
is recent: a release cannot go back to an earlier one after its migrations ran. When the release notes of a release
since the running one change `docker-compose.yml`, apply those changes to the installation's own file first.

Run this in the folder of `docker-compose.yml` and `.env`, with the new release in `NEW`. It pulls the image first
and changes nothing when the pull fails. It then sets `VERSION` in `.env` (in the file a symbolic link points to, if
`.env` is one), stops the server if one runs and starts it on the new release, which migrates the database on start;
Compose waits until it is healthy. Every Compose command gets the release explicitly, so a `VERSION` exported in the
shell cannot start another one.

```bash
NEW=X.Y.Z
VERSION="$NEW" docker compose pull server &&
  sed -i --follow-symlinks "s/^VERSION=.*/VERSION=$NEW/" .env &&
  VERSION="$NEW" docker compose stop server &&
  VERSION="$NEW" docker compose up -d --no-deps --wait --wait-timeout 300 server
```

This replaces only the server. When the release notes change the image of `postgres`, update that service in its own
step first, with `docker compose up -d --wait postgres` so that it is healthy before the server starts.

Check the version the server reports:

```bash
VERSION="$NEW" docker compose exec -T -u node server node -e 'fetch("http://127.0.0.1:8080/healthz/live").then((r) => r.json()).then((b) => console.log(b.version))'
```

## Two server containers after an interrupted rollout

`docker compose ps server` lists the server containers. When two run, check which one runs the release in `.env`
(`docker inspect -f '{{.Config.Image}}' <container>`), that it is healthy and receives requests, then stop the other
with `docker stop <container>`, which honours the stop grace period, and remove it with `docker rm <container>`. A
container left unhealthy by a drain whose rollout was interrupted is removed the same way.
