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
# SERVICES="worker" rolls only the ones named, still in that order.
# ROLLOUT_TIMEOUT (seconds, default 180) is how long a new container has to
# become healthy. Needs the docker rollout plugin
# (github.com/wowu/docker-rollout) and flock.
#
# docker rollout starts the new container beside the old one and removes the
# old one only once the new one is healthy. A new container that does not
# become healthy is removed and the old one keeps serving; the script then
# stops and says where it stood. When it stops, or is interrupted, before
# rolling anything, the VERSION line goes back to what it was.
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
    in_services && /^  [^ ]/ { service = $1; sub(/:$/, "", service); gsub(/^["\047]|["\047]$/, "", service) }
    in_services && $0 ~ "^    " key ": " { value = $2; gsub(/^["\047]|["\047]$/, "", value); print service, value }
  '
}

# The value of VERSION in .env as Compose reads it: no comment, quotes or CR.
env_version() {
  grep -m 1 "^VERSION=" .env | cut -d= -f2- |
    sed -E "s/\r$//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

# Replaces the first VERSION line of .env with the given line, taken literally.
# The file is rewritten in place, so its owner and mode stay.
write_version_line() {
  local text
  text="$(LINE="$1" awk '/^VERSION=/ && !done { print ENVIRON["LINE"]; done = 1; next } { print }' .env)"
  printf '%s\n' "$text" >.env
}

if [[ ! -f docker-compose.yml || ! -f .env ]]; then
  err "Run this beside the deployment's docker-compose.yml and .env."
  exit 1
fi
if ! docker rollout --help 2>/dev/null | grep -q "docker rollout"; then
  err "The docker rollout plugin is not installed: https://github.com/wowu/docker-rollout"
  exit 1
fi
if ! command -v flock >/dev/null; then
  err "flock is not installed (it comes with util-linux)."
  exit 1
fi
# One update at a time: a second run would change VERSION under the first.
exec 9<"$(basename "${BASH_SOURCE[0]}")"
if ! flock -n 9; then
  err "Another update.sh is running in this folder. Wait for it to finish."
  exit 1
fi
if ! grep -q "^VERSION=" .env; then
  err ".env has no VERSION line."
  exit 1
fi

previous_line=""
changed=""
rolled=()
rolling=""

restore() {
  if [[ -n $changed ]]; then
    write_version_line "$previous_line"
    changed=""
    warn "The VERSION line in .env is back to what it was: $previous_line"
  fi
}
# Ends the update with the given exit code: before anything was rolled,
# VERSION goes back; after, it stays, since some services already run the new
# release.
halt() {
  local code="$1"
  shift
  err "$*"
  if ((${#rolled[@]} == 0)); then
    restore
  else
    warn "Already on the new release: ${rolled[*]}. Fix the cause and run this again."
  fi
  exit "$code"
}
stop() { halt 1 "$@"; }
interrupted() {
  if [[ -n $rolling ]]; then
    err "Interrupted while rolling $rolling. VERSION stays ${expected:-as it is}; check the containers with: docker compose ps"
    exit 130
  fi
  halt 130 "Interrupted."
}
trap interrupted INT TERM

version="${1:-}"
if [[ -n $version ]]; then
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err "A release looks like 0.10.0, not '$version'."
    exit 1
  fi
  previous_line="$(grep -m 1 "^VERSION=" .env)"
  changed=1
  write_version_line "VERSION=$version"
  log "VERSION=$version in .env (it was: $previous_line)."
fi
expected="$(env_version)"

# The services that run an n8n-ops image, the server first: it migrates the
# database, and the worker calls it.
declare -A image_of=()
servers=()
workers=()
config="$(service_values image)" || stop "docker compose config failed: see above."
while read -r service image; do
  [[ -n $service ]] || continue
  image_of[$service]="$image"
  case "${image%:*}" in
    "$SERVER_IMAGE") servers+=("$service") ;;
    "$WORKER_IMAGE") workers+=("$service") ;;
  esac
done <<<"$config"
targets=("${servers[@]}" "${workers[@]}")
if ((${#targets[@]} == 0)); then
  stop "No service in docker-compose.yml runs $SERVER_IMAGE or $WORKER_IMAGE."
fi
services=("${targets[@]}")
if [[ -n ${SERVICES:-} ]]; then
  read -r -a wanted <<<"$SERVICES"
  for service in "${wanted[@]}"; do
    if [[ " ${targets[*]} " != *" $service "* ]]; then
      stop "$service is not a service of docker-compose.yml that runs $SERVER_IMAGE or $WORKER_IMAGE."
    fi
  done
  services=()
  for service in "${targets[@]}"; do
    if [[ " ${wanted[*]} " == *" $service "* ]]; then
      services+=("$service")
    fi
  done
fi

for service in "${services[@]}"; do
  tag="${image_of[$service]##*:}"
  if [[ $tag != "$expected" ]]; then
    stop "$service runs ${image_of[$service]}, not version $expected. Write its image as ...:\${VERSION} in docker-compose.yml and run this again."
  fi
done
# A fixed container name allows one container per service, and docker rollout
# needs two for a moment.
names="$(service_values container_name)" || stop "docker compose config failed: see above."
while read -r service name; do
  if [[ -n $service && " ${services[*]} " == *" $service "* ]]; then
    stop "$service has container_name: $name in docker-compose.yml, so docker rollout cannot run it twice. Remove that line and run this again."
  fi
done <<<"$names"
# Beside a running container, docker rollout replaces only the stopped ones of
# the service and reports success without rolling the running one.
declare -A running_ids=()
for service in "${services[@]}"; do
  all="$(docker compose ps -aq "$service")" || stop "Could not read the containers of $service from Docker."
  running="$(docker compose ps -q "$service")" || stop "Could not read the containers of $service from Docker."
  running_ids[$service]="$running"
  if [[ -n $running ]] && (($(wc -w <<<"$all") != $(wc -w <<<"$running"))); then
    stop "$service has stopped containers beside the running one, and docker rollout would replace only those. Remove them with: docker compose rm -f $service"
  fi
done

log "Pulling: ${services[*]}"
if ! docker compose pull "${services[@]}"; then
  stop "Pulling failed: nothing was changed."
fi

for service in "${services[@]}"; do
  if [[ -z ${running_ids[$service]} ]]; then
    log "$service is not running: starting it."
    # --no-deps: the database, the socket proxy and other services stay as they are.
    started=(docker compose up -d --no-deps --wait --wait-timeout "$TIMEOUT" "$service")
  else
    log "Rolling $service"
    started=(docker rollout --timeout "$TIMEOUT" "$service")
  fi
  rolling="$service"
  if ! "${started[@]}"; then
    rolling=""
    stop "$service did not come up healthy. Its old container, if it had one, still runs."
  fi
  rolling=""
  rolled+=("$service")
done
changed=""

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
