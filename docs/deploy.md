# Deploying a release

This document describes what each release publishes for deployment tools and how to update a production
installation from one release to the next.

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

The server image carries two labels that a zero-downtime rollout with docker rollout can compare between the running
image and the new one before it starts the new container beside the old one:

| Label | Value |
|---|---|
| `n8n-ops.compose-sha256` | The SHA-256 of `docker-compose.yml` in the release commit |
| `n8n-ops.rollout-from` | The oldest running release this image may run beside |

Every release sets `n8n-ops.rollout-from` to its own version. The server is not yet safe to run twice at once: each
server process runs all scheduled background work, including the writing of backup copies, and nothing chooses one
process to do it. A tool that respects the label therefore refuses to roll the server out beside an older release,
and each release is updated with a short downtime as described below. `scripts/update.sh` does not read these labels.

The worker image carries neither label.

Check the labels of a release:

```bash
docker image inspect ghcr.io/shlomiporush/n8n-ops:X.Y.Z \
  --format '{{index .Config.Labels "n8n-ops.compose-sha256"}} {{index .Config.Labels "n8n-ops.rollout-from"}}'
```

## What the installation needs

These rules hold for the `docker-compose.yml` and `.env` on the host. The tracked `docker-compose.yml` follows them.

- `name: n8n-ops` at the top of `docker-compose.yml`, so the Compose project name is `n8n-ops`.
- The `server` service uses `image: ghcr.io/shlomiporush/n8n-ops:${VERSION}`.
- `.env` has exactly one `VERSION=X.Y.Z` line.
- The `server` service has no `container_name`, no published port, no `network_mode: host`, no `build` and one
  replica. Requests reach it through a reverse proxy, for example Traefik labels.
- The `server` service keeps the health check of the image (`/healthz/ready`, which includes the database), or
  defines the same one.
- A restart policy such as `restart: unless-stopped`.

## Update with downtime

Before an update, make sure that the n8n-ops database backup (Backups → n8n-ops database) is recent: a release
cannot go back to an earlier one after its migrations ran. When the release notes of a release since the running one
change `docker-compose.yml`, apply those changes to the installation's own file first.

Run this in the folder of `docker-compose.yml` and `.env`, with the new release in `NEW`. It pulls the image first
and changes nothing when the pull fails. It then sets `VERSION` in `.env` (in the file a symbolic link points to, if
`.env` is one), stops the server and starts it on the new release, which migrates the database on start; Compose
waits until it is healthy. Every Compose command gets the release explicitly, so a `VERSION` exported in the shell
cannot start another one.

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
