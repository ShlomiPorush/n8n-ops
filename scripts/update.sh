#!/usr/bin/env bash
#
# update.sh - move a production deployment of n8n-ops to a release with no
# downtime, one service at a time, with docker rollout.
#
#   ./update.sh 0.10.0    roll the services to 0.10.0 and set VERSION in .env
#   ./update.sh           pull and roll the release already set
#
# Copy it beside the deployment's docker-compose.yml and .env, like the
# Compose file itself. It rolls the services that run an n8n-ops image, found
# by image and not by name: the server first, then a worker if the same file
# has one. Other services are not updated. SERVICES="worker" rolls only the
# ones named, still in that order. ROLLOUT_TIMEOUT (seconds, default 180) is
# how long a new container has to become healthy. Needs the docker rollout
# plugin (github.com/wowu/docker-rollout) and flock.
#
# docker rollout starts the new container beside the old one and removes the
# old one only once the new one is healthy. A new container that does not
# become healthy is removed and the old one keeps serving; the script then
# stops and says where it stood. .env changes right before the first service
# is rolled, and only its VERSION lines; when that service does not end up on
# the new release, they go back to the release that ran before.
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
# one of its keys (image, container_name), when it has that key. Arguments
# before the key go in front of docker compose (env VERSION=... to resolve
# another release).
service_values() {
  local key="${*: -1}"
  "${@:1:$#-1}" docker compose config | awk -v key="$key" '
    /^services:/ { in_services = 1; next }
    in_services && /^[^ ]/ { in_services = 0 }
    in_services && /^  [^ ]/ { service = $1; sub(/:$/, "", service); gsub(/^["\047]|["\047]$/, "", service) }
    in_services && $0 ~ "^    " key ": " { value = $2; gsub(/^["\047]|["\047]$/, "", value); print service, value }
  '
}

# The images the running containers of a service were created from.
running_images() {
  local ids
  ids="$(docker compose ps -q "$1")" || return 1
  # shellcheck disable=SC2086 # one argument per container id
  [[ -z $ids ]] || docker inspect -f '{{.Config.Image}}' $ids
}

# Sets every VERSION line of .env, as it is now, to the given value. The new
# text goes to a private file (mktemp, owner only) and then into .env itself,
# which keeps its owner, mode and symlink target. A write cut short leaves
# that file, with the full text, for the operator.
edited=""
env_tmp=""
env_partial=""
env_value=""
write_version() {
  env_value="$1"
  env_tmp="$(mktemp .env.update.XXXXXX)" || return 1
  sed "s/^VERSION=.*/VERSION=$1/" .env >"$env_tmp" || return 1
  edited=1
  env_partial=1
  cat "$env_tmp" >.env || return 1
  env_partial=""
  rm -f "$env_tmp"
  env_tmp=""
}
cleanup() {
  [[ -n $env_tmp ]] || return 0
  if [[ -n $env_partial ]]; then
    err "Writing .env was cut short. Its full text with VERSION=$env_value is in $env_tmp: put it in place with: cat $env_tmp > .env && rm $env_tmp"
  else
    rm -f "$env_tmp"
  fi
}
trap cleanup EXIT

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
# One update at a time in this folder. The lock is on the folder, which an
# editor never replaces.
exec 9<.
if ! flock -n 9; then
  err "Another update.sh is running in this folder. Wait for it to finish."
  exit 1
fi
# Compose would take an exported VERSION before .env, and docker rollout sets
# a VERSION of its own that would then reach Compose.
if [[ -n ${VERSION+set} ]]; then
  err "VERSION is set in this shell's environment. Unset it (unset VERSION) and run this again."
  exit 1
fi

rolled=()
rolling=""
previous=""
# Puts the VERSION lines back when .env was changed and no service runs the
# new release.
restore() {
  # A signal lands only after cat returns, so a write may be complete though
  # not yet marked so.
  if [[ -n $env_partial ]] && cmp -s "$env_tmp" .env; then
    env_partial=""
  fi
  [[ -n $edited && ${#rolled[@]} -eq 0 && -z $env_partial ]] || return 0
  if write_version "$previous"; then
    warn "VERSION is back to $previous in .env."
  else
    err "Could not set VERSION back to $previous in .env. Set it there by hand."
  fi
}
stop() {
  err "$*"
  restore
  if ((${#rolled[@]} > 0)); then
    warn "On the new release: ${rolled[*]}. Fix the cause and run this again."
  fi
  exit 1
}
# Records a service as rolled when its running containers use the new image,
# whatever the command reported. Leaves what the service runs in $images.
images=""
record() {
  images="$(running_images "$1")" || return 1
  if grep -qxF "${image_of[$1]}" <<<"$images"; then
    [[ " ${rolled[*]} " == *" $1 "* ]] || rolled+=("$1")
  fi
}
interrupted() {
  trap - INT TERM
  if [[ -n $rolling ]]; then
    if record "$rolling"; then
      err "Interrupted while rolling $rolling. It now runs: $(tr '\n' ' ' <<<"$images")Check its containers with docker compose ps $rolling, and remove one you do not want with docker rm -f <container>."
    else
      # Unknown what runs: leave .env as it is rather than guess.
      rolled+=("$rolling")
      err "Interrupted while rolling $rolling, and Docker did not say what runs now. .env has VERSION=$version; check with: docker compose ps $rolling"
    fi
  else
    err "Interrupted."
  fi
  restore
  if ((${#rolled[@]} > 0)); then
    warn "On the new release: ${rolled[*]}."
  fi
  exit 130
}
trap interrupted INT TERM

version="${1:-}"
new_env=()
if [[ -n $version ]]; then
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err "A release looks like 0.10.0, not '$version'."
    exit 1
  fi
  if ! grep -q "^VERSION=" .env; then
    err ".env has no VERSION line."
    exit 1
  fi
  # For the checks and the pull only; .env changes right before the rollout.
  new_env=(env "VERSION=$version")
fi

# The services that run an n8n-ops image, the server first: it migrates the
# database, and the worker calls it. The images come from Compose itself, as
# it resolves VERSION.
declare -A image_of=()
servers=()
workers=()
config="$(service_values "${new_env[@]}" image)" || stop "docker compose config failed: see above."
while read -r service image; do
  [[ -n $service ]] || continue
  image_of[$service]="$image"
  case "${image%:*}" in
    "$SERVER_IMAGE") servers+=("$service") ;;
    "$WORKER_IMAGE") workers+=("$service") ;;
  esac
done <<<"$config"
services=("${servers[@]}" "${workers[@]}")
if [[ -n ${SERVICES+set} ]]; then
  read -r -a wanted <<<"$SERVICES"
  for service in "${wanted[@]}"; do
    if [[ " ${services[*]} " != *" $service "* ]]; then
      stop "$service is not a service of docker-compose.yml that runs $SERVER_IMAGE or $WORKER_IMAGE."
    fi
  done
  detected=("${services[@]}")
  services=()
  for service in "${detected[@]}"; do
    if [[ " ${wanted[*]} " == *" $service "* ]]; then
      services+=("$service")
    fi
  done
fi
if ((${#services[@]} == 0)); then
  stop "No service to roll: none in docker-compose.yml runs $SERVER_IMAGE or $WORKER_IMAGE, or SERVICES is empty."
fi

expected="${version:-${image_of[${services[0]}]##*:}}"
for service in "${services[@]}"; do
  if [[ ${image_of[$service]##*:} != "$expected" ]]; then
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
# The release .env holds now, to put back if the first service fails.
if [[ -n $version ]]; then
  current="$(service_values image)" || stop "docker compose config failed: see above."
  previous="$(awk -v s="${services[0]}" '$1 == s { sub(/.*:/, "", $2); print $2 }' <<<"$current")"
  if [[ ! $previous =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]]; then
    stop "Could not read the release ${services[0]} runs now from docker-compose.yml and .env."
  fi
fi

log "Pulling: ${services[*]}"
if ! "${new_env[@]}" docker compose pull "${services[@]}"; then
  stop "Pulling failed: nothing was changed."
fi

for service in "${services[@]}"; do
  # Read right before acting: a container may have stopped or come back
  # during the pull.
  all="$(docker compose ps -aq "$service")" || stop "Could not read the containers of $service from Docker."
  running="$(docker compose ps -q "$service")" || stop "Could not read the containers of $service from Docker."
  if [[ -n $running ]] && (($(wc -w <<<"$all") != $(wc -w <<<"$running"))); then
    # Beside a running container, docker rollout replaces only the stopped
    # ones and reports success without rolling the running one.
    stop "$service has stopped containers beside the running one, and docker rollout would replace only those. Remove them with: docker compose rm -f $service"
  fi
  # .env first, so that a service reading it (env_file) starts with it.
  if [[ -n $version && -z $edited ]]; then
    write_version "$version" || stop "Could not write VERSION=$version into .env."
    log "VERSION=$version in .env."
  fi
  if [[ -z $running ]]; then
    log "$service is not running: starting it."
    # --no-deps: the database, the socket proxy and other services stay as they are.
    started=(docker compose up -d --no-deps --wait --wait-timeout "$TIMEOUT" "$service")
  else
    log "Rolling $service"
    started=(docker rollout --timeout "$TIMEOUT" "$service")
  fi
  rolling="$service"
  ok=1
  "${started[@]}" || ok=""
  # What runs now decides, not the exit code alone: docker rollout can fail
  # after the new container took over, and a replica can stay behind.
  if ! record "$service"; then
    # Unknown what runs: leave .env as it is rather than guess.
    rolled+=("$service")
    rolling=""
    stop "Docker did not say what $service runs now. .env has VERSION=$expected; check with: docker compose ps $service"
  fi
  rolling=""
  if [[ -z $ok ]]; then
    stop "$service did not come up healthy. It now runs: ${images:-nothing}"
  fi
  if grep -vqxF "${image_of[$service]}" <<<"$images"; then
    stop "$service still has containers on another image. It now runs: $(tr '\n' ' ' <<<"$images")Check them with: docker compose ps $service"
  fi
done

docker compose ps "${services[@]}"

# The version the server itself reports, from inside its container, so the
# check needs neither a published port nor the public domain.
for service in "${servers[@]}"; do
  [[ " ${rolled[*]} " == *" $service "* ]] || continue
  # shellcheck disable=SC2016 # expands inside the container
  reported="$(docker compose exec -T -u node "$service" node -e 'fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/healthz/live`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((b) => console.log(b.version))' 2>/dev/null)" || reported=""
  if [[ -z $reported ]]; then
    warn "Could not read the version of $service from /healthz/live. Check it with: curl -fsS https://<DOMAIN>/healthz/live"
  elif [[ $reported != "$expected" ]]; then
    warn "$service reports version $reported, not $expected."
  else
    log "$service reports version $reported."
  fi
done

log "Done: ${rolled[*]}"
