#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TIMEOUT="${ROLLOUT_TIMEOUT:-180}"
SERVER_IMAGE="ghcr.io/shlomiporush/n8n-ops"
WORKER_IMAGE="ghcr.io/shlomiporush/n8n-ops-worker"

log() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

service_values() {
  local key="${*: -1}"
  "${@:1:$#-1}" docker compose config | awk -v key="$key" '
    /^services:/ { in_services = 1; next }
    in_services && /^[^ ]/ { in_services = 0 }
    in_services && /^  [^ ]/ { service = $1; sub(/:$/, "", service); gsub(/^["\047]|["\047]$/, "", service) }
    in_services && $0 ~ "^    " key ": " { value = $2; gsub(/^["\047]|["\047]$/, "", value); print service, value }
  '
}

running_images() {
  local ids
  ids="$(docker compose ps -q "$1")" || return 1
  # shellcheck disable=SC2086 # one argument per container id
  [[ -z $ids ]] || docker inspect -f '{{.Config.Image}}' $ids
}

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
  # mv would replace .env's owner, mode and symlink.
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
exec 9<.
if ! flock -n 9; then
  err "Another update.sh is running in this folder. Wait for it to finish."
  exit 1
fi
if [[ -n ${VERSION+set} ]]; then
  err "VERSION is set in this shell's environment. Unset it (unset VERSION) and run this again."
  exit 1
fi

rolled=()
rolling=""
previous=""
restore() {
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
      # Left out of rolled, restore would put the old VERSION back while the new release may run.
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
  new_env=(env "VERSION=$version")
fi

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
names="$(service_values container_name)" || stop "docker compose config failed: see above."
while read -r service name; do
  if [[ -n $service && " ${services[*]} " == *" $service "* ]]; then
    stop "$service has container_name: $name in docker-compose.yml, so docker rollout cannot run it twice. Remove that line and run this again."
  fi
done <<<"$names"
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
  all="$(docker compose ps -aq "$service")" || stop "Could not read the containers of $service from Docker."
  running="$(docker compose ps -q "$service")" || stop "Could not read the containers of $service from Docker."
  if [[ -n $running ]] && (($(wc -w <<<"$all") != $(wc -w <<<"$running"))); then
    stop "$service has stopped containers beside the running one, and docker rollout would replace only those. Remove them with: docker compose rm -f $service"
  fi
  if [[ -n $version && -z $edited ]]; then
    write_version "$version" || stop "Could not write VERSION=$version into .env."
    log "VERSION=$version in .env."
  fi
  if [[ -z $running ]]; then
    log "$service is not running: starting it."
    started=(docker compose up -d --no-deps --wait --wait-timeout "$TIMEOUT" "$service")
  else
    log "Rolling $service"
    started=(docker rollout --timeout "$TIMEOUT" "$service")
  fi
  rolling="$service"
  ok=1
  "${started[@]}" || ok=""
  if ! record "$service"; then
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
