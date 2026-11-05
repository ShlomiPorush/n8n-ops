#!/usr/bin/env bash
#
# update.sh - move a production deployment of n8n-ops to a release with no
# downtime, one service at a time, with docker rollout.
#
#   ./update.sh 0.10.0    set VERSION in .env, pull it, roll the services
#   ./update.sh           pull and roll the VERSION already in .env
#
# Copy it beside the deployment's docker-compose.yml and .env, like the
# Compose file itself. It rolls the services that run an n8n-ops image, found
# by image and not by name: the server first, then a worker if the same file
# has one. The database, the socket proxy and anything else stay as they are.
# SERVICES="worker" rolls only the ones named. ROLLOUT_TIMEOUT (seconds,
# default 180) is how long a new container has to become healthy. Needs the
# docker rollout plugin (github.com/wowu/docker-rollout).
#
# docker rollout starts the new container beside the old one and removes the
# old one only once the new one is healthy. A new container that does not
# become healthy is removed and the old one keeps serving; the script then
# stops and says where it stood. When nothing was rolled yet, VERSION goes
# back to what it was.
#
# The server migrates the database when its new container starts, while the
# old one still serves. A release whose migration breaks the previous release
# needs an update with downtime instead (docker compose up -d); its CHANGELOG
# entry says so.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TIMEOUT="${ROLLOUT_TIMEOUT:-180}"
SERVER_IMAGE="ghcr.io/shlomiporush/n8n-ops"
WORKER_IMAGE="ghcr.io/shlomiporush/n8n-ops-worker"

log() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# One line per service of the resolved Compose file: its name and the value of
# one of its keys (image, container_name), when it has that key.
service_values() {
  docker compose config | awk -v key="$1" '
    /^services:/ { in_services = 1; next }
    in_services && /^[^ ]/ { in_services = 0 }
    in_services && /^  [^ ]/ { service = $1; sub(/:$/, "", service) }
    in_services && $0 ~ "^    " key ": " { print service, $2 }
  '
}

if [[ ! -f docker-compose.yml || ! -f .env ]]; then
  err "Run this beside the deployment's docker-compose.yml and .env."
  exit 1
fi
if ! docker rollout --help 2>/dev/null | grep -q "docker rollout"; then
  err "The docker rollout plugin is not installed: https://github.com/wowu/docker-rollout"
  exit 1
fi
if ! grep -q "^VERSION=" .env; then
  err ".env has no VERSION line."
  exit 1
fi

version="${1:-}"
previous=""
if [[ -n $version ]]; then
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err "A release looks like 0.10.0, not '$version'."
    exit 1
  fi
  previous="$(grep -m 1 "^VERSION=" .env | cut -d= -f2-)"
  sed -i "s/^VERSION=.*/VERSION=${version}/" .env
  log "VERSION=$version in .env (it was $previous)."
fi
expected="$(grep -m 1 "^VERSION=" .env | cut -d= -f2- | tr -d "\"'")"

restore() {
  if [[ -n $previous ]]; then
    sed -i "s/^VERSION=.*/VERSION=${previous}/" .env
    warn "VERSION is back to $previous."
  fi
}
fail() {
  err "$*"
  restore
  exit 1
}

# The services that run an n8n-ops image, the server first: it migrates the
# database, and the worker calls it.
declare -A image_of=()
servers=()
workers=()
while read -r service image; do
  image_of[$service]="$image"
  case "${image%:*}" in
    "$SERVER_IMAGE") servers+=("$service") ;;
    "$WORKER_IMAGE") workers+=("$service") ;;
  esac
done < <(service_values image)
if [[ -n ${SERVICES:-} ]]; then
  read -r -a services <<<"$SERVICES"
  for service in "${services[@]}"; do
    [[ -n ${image_of[$service]:-} ]] || fail "docker-compose.yml has no service $service."
  done
else
  services=("${servers[@]}" "${workers[@]}")
fi
if ((${#services[@]} == 0)); then
  fail "No service in docker-compose.yml runs $SERVER_IMAGE or $WORKER_IMAGE."
fi

for service in "${services[@]}"; do
  tag="${image_of[$service]##*:}"
  if [[ $tag != "$expected" ]]; then
    fail "$service runs ${image_of[$service]}, not version $expected. Write its image as ...:\${VERSION} in docker-compose.yml and run this again."
  fi
done
# A fixed container name allows one container per service, and docker rollout
# needs two for a moment.
while read -r service name; do
  if [[ " ${services[*]} " == *" $service "* ]]; then
    fail "$service has container_name: $name in docker-compose.yml, so docker rollout cannot run it twice. Remove that line and run this again."
  fi
done < <(service_values container_name)

log "Pulling: ${services[*]}"
if ! docker compose pull "${services[@]}"; then
  err "Pulling failed: nothing was changed."
  restore
  exit 1
fi

rolled=()
for service in "${services[@]}"; do
  if [[ -z $(docker compose ps -q "$service") ]]; then
    log "$service is not running: starting it."
    started=(docker compose up -d --wait --wait-timeout "$TIMEOUT" "$service")
  else
    log "Rolling $service"
    started=(docker rollout --timeout "$TIMEOUT" "$service")
  fi
  if ! "${started[@]}"; then
    err "$service did not come up healthy. Its old container, if it had one, still runs."
    if ((${#rolled[@]} == 0)); then
      restore
    else
      warn "Already on the new release: ${rolled[*]}. Fix the cause and run this again."
    fi
    exit 1
  fi
  rolled+=("$service")
done

docker compose ps "${services[@]}"

# The version the server itself reports, from inside its container, so the
# check needs neither a published port nor the public domain.
for service in "${servers[@]}"; do
  [[ " ${rolled[*]} " == *" $service "* ]] || continue
  # shellcheck disable=SC2016 # expands inside the container
  running="$(docker compose exec -T -u node "$service" node -e 'fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/healthz/live`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((b) => console.log(b.version))' 2>/dev/null)" || running=""
  if [[ -z $running ]]; then
    warn "Could not read the version of $service from /healthz/live. Check it with: curl -fsS https://<DOMAIN>/healthz/live"
  elif [[ $running != "$expected" ]]; then
    warn "$service reports version $running, not $expected."
  else
    log "$service reports version $running."
  fi
done

log "Done: ${rolled[*]}"
