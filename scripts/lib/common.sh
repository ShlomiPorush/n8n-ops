# Shared helpers for the workflow scripts. Source it; do not execute it.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

TOOLCHAIN_IMAGE="n8n-ops-toolchain:local"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/n8n-ops"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not available. Run this inside WSL with Docker running."
  docker info >/dev/null 2>&1 || die "docker is installed but not reachable. Start Docker and try again."
}

# Builds the toolchain image (cached by Docker when nothing changed).
build_toolchain() {
  require_docker
  docker build --quiet -f "$REPO_ROOT/docker/toolchain.Dockerfile" -t "$TOOLCHAIN_IMAGE" "$REPO_ROOT/docker" >/dev/null ||
    die "building the toolchain image failed"
}

# Runs a command inside the toolchain container with the repository mounted at /repo.
in_toolchain() {
  mkdir -p "$CACHE_DIR/pnpm-store"
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/repo" \
    -v "$CACHE_DIR/pnpm-store:/pnpm-store" \
    -e npm_config_store_dir=/pnpm-store \
    -e CI="${CI:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLCHAIN_EXTRA_ARGS[@]}" \
    "$TOOLCHAIN_IMAGE" bash -c "$*"
}
TOOLCHAIN_EXTRA_ARGS=()

# Installs workspace dependencies from the lockfile.
install_deps() {
  in_toolchain "pnpm install --frozen-lockfile --reporter=append-only"
}

# Builds the server and worker images with the given tag; each reports the version in VERSION. Stops on the first
# failure.
build_images() {
  local tag="$1"
  require_docker
  local app
  for app in server worker; do
    info "Building n8n-ops-$app:$tag"
    docker build -f "$REPO_ROOT/docker/$app.Dockerfile" -t "n8n-ops-$app:$tag" "$REPO_ROOT" ||
      die "building n8n-ops-$app:$tag failed"
  done
}

# Pulls external images in the background, so they download while other work runs. An image already
# present is left as it is, as Compose would, so a run without network still works from the local cache.
# Each pull tries three times; wait_for_pulls waits for the images given right before their first use.
declare -gA PULL_PIDS=()
PULL_LOGS=""

pull_log() {
  echo "$PULL_LOGS/${1//[^A-Za-z0-9._-]/_}.log"
}

start_pulls() {
  local image held="" int_trap term_trap
  # Ctrl-C or a stop while a pull starts waits until it is in PULL_PIDS, so stop_pulls always finds it. The pulls
  # themselves get the default handling: a shell resets caught signals in what it starts.
  int_trap="$(trap -p INT)"
  term_trap="$(trap -p TERM)"
  trap 'held=130' INT
  trap 'held=143' TERM
  for image in "$@"; do
    [ -z "${PULL_PIDS[$image]:-}" ] || continue
    docker image inspect "$image" >/dev/null 2>&1 && continue
    [ -n "$PULL_LOGS" ] || PULL_LOGS="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-pulls.XXXXXX")"
    # A process group of its own (setsid execs in place, so the pid is the group's), which stop_pulls ends whole:
    # the retry loop and whatever it runs at that moment.
    # shellcheck disable=SC2016 # Expanded by the inner shell.
    setsid bash -c '
      for try in 1 2 3; do
        echo "pull $try of 3: $1"
        docker pull --quiet "$1" && exit 0
        [ "$try" = 3 ] || sleep $((try * 5))
      done
      exit 1
    ' _ "$image" >"$(pull_log "$image")" 2>&1 &
    PULL_PIDS[$image]=$!
  done
  eval "${int_trap:-trap - INT}"
  eval "${term_trap:-trap - TERM}"
  [ -z "$held" ] || exit "$held"
}

# Waits for the background pulls of the images given. An image that is not being pulled passes at once.
wait_for_pulls() {
  local image pid
  for image in "$@"; do
    pid="${PULL_PIDS[$image]:-}"
    [ -n "$pid" ] || continue
    if ! wait "$pid"; then
      cat "$(pull_log "$image")" >&2 || true
      die "could not pull $image"
    fi
    unset 'PULL_PIDS[$image]'
  done
}

# Stops the pulls that still run when the script ends early, failed or interrupted, waits for them, and removes
# their logs. A pull already waited for is gone from PULL_PIDS.
stop_pulls() {
  local pid
  for pid in "${PULL_PIDS[@]}"; do
    # The whole group at once, so the loop cannot start another try in between. Stopped so early that it had not
    # made its group yet: the process, then the group again, which it may have made and filled meanwhile.
    if ! kill -TERM -- "-$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      kill -TERM -- "-$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  PULL_PIDS=()
  [ -z "$PULL_LOGS" ] || rm -rf "$PULL_LOGS"
  PULL_LOGS=""
}

docker_socket_gid() {
  local sock=/var/run/docker.sock
  [ -S "$sock" ] || die "Docker socket not found at $sock"
  stat -c %g "$sock"
}

# Fails when any process of a running Compose service runs as UID 0. The server's health check
# starts as root for a moment before it drops to node, so a root process must still be there after
# a few looks a second apart.
check_non_root() {
  local project="$1" service cid uids try
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    for try in 1 2 3 4 5; do
      uids="$(docker top "$cid" -o pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
      grep -qw 0 <<<"$uids" || break
      [ "$try" = 5 ] && die "service $service runs a process as root (UIDs: $uids)"
      sleep 1
    done
    echo "    $service runs as UID ${uids% }"
  done
}

# The socket proxy may run as root, only to open the Docker socket: it must hold no capability, run
# with no new privileges on a read-only file system, and publish no port.
check_socket_proxy() {
  local project="$1" cid
  cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=socket-proxy")"
  [ -n "$cid" ] || die "service socket-proxy is not running"
  # The image has no shell, so the check reads what Docker enforces: every capability dropped, none added.
  [ "$(docker inspect -f '{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}}' "$cid")" = '["ALL"] null' ] ||
    die "socket-proxy holds capabilities"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || die "socket-proxy has a writable file system"
  # On only as "no-new-privileges" or "no-new-privileges:true"; ":false" turns it off.
  docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$cid" | grep -qxE 'no-new-privileges(:true)?' ||
    die "socket-proxy may gain new privileges"
  [ -z "$(docker port "$cid")" ] || die "socket-proxy publishes a port"
  echo "    socket-proxy holds no capabilities, read-only, no new privileges, no published port"
}

# Removes a project-owned data directory. Files written by containers may belong to other UIDs,
# so the contents are deleted from a throwaway container.
remove_data_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" bash -c 'shopt -s dotglob; rm -rf /target/*' ||
    die "could not empty $dir"
  rmdir "$dir"
}

# --- Stack secrets (AGENTS.md, Secrets) ---
# No tracked file holds a working secret. Each stack's env files are made from docker/env/*.env.example into a
# directory of its own (N8N_OPS_ENV_DIR), owner-only, with every empty value in an example filled with a new random
# value. A file that exists is never rewritten.

# Values that only stand for a secret: an example's placeholder, or a word anyone would guess. Lower case.
SECRET_PLACEHOLDERS='^(|replace-with.*|change-?me.*|example.*|placeholder.*|password|secret|postgres|n8n_ops|test)$'

# 32 random bytes as hex: no quoting is ever needed in a URL, SQL or an env file.
random_secret() {
  local value
  if command -v openssl >/dev/null 2>&1; then
    value="$(openssl rand -hex 32)"
  else
    value="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  fi
  [ ${#value} -eq 64 ] || die "could not generate a random secret"
  printf '%s' "$value"
}

# Fails unless the path is the current user's and has exactly this mode as the file system reports it back.
require_owner_only() {
  local path="$1" mode="$2"
  [ "$(stat -c %u "$path")" = "$(id -u)" ] || die "$path is not yours; secrets must be readable by their owner only"
  [ "$(stat -c %a "$path")" = "$mode" ] ||
    die "$path has mode $(stat -c %a "$path"), not $mode. Its file system does not keep owner-only permissions (for example /mnt/c); keep the data directory on the Linux file system."
}

# Creates the env directory owner-only, and proves its file system keeps that before any secret is written.
prepare_env_dir() {
  local dir="$1" probe
  (umask 077 && mkdir -p "$dir") || die "could not create $dir"
  chmod 0700 "$dir" || die "could not make $dir owner-only"
  require_owner_only "$dir" 700
  probe="$(mktemp "$dir/.probe.XXXXXX")" || die "could not write in $dir"
  chmod 0600 "$probe"
  require_owner_only "$probe" 600
  rm -f "$probe"
}

env_value() {
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# Writes a file only when it does not exist yet: made aside, then linked into place, which fails when another
# file is there, so an existing one is never rewritten.
publish_env_file() {
  local dir="$1" name="$2" content="$3" tmp
  [ -e "$dir/$name" ] && return 0
  tmp="$(mktemp "$dir/.$name.XXXXXX")" || die "could not write in $dir"
  chmod 0600 "$tmp"
  printf '%s\n' "$content" >"$tmp"
  ln "$tmp" "$dir/$name" 2>/dev/null || true
  rm -f "$tmp"
  [ -f "$dir/$name" ] || die "could not write $dir/$name"
}

# The content of docker/env/<name>.env.example with each empty value taken from the NAME=value arguments; an empty
# value with no argument stops, so nothing starts with a blank secret.
fill_env_example() {
  local name="$1" line key given found
  shift
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z0-9_]+)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      found=""
      for given in "$@"; do
        [ "${given%%=*}" = "$key" ] && found="${given#*=}"
      done
      [ -n "$found" ] || die "docker/env/$name.env.example leaves $key empty and nothing fills it"
      line="$key=$found"
    fi
    printf '%s\n' "$line"
  done <"$REPO_ROOT/docker/env/$name.env.example"
}

STACK_ENV_FILES=(postgres server worker n8n s3)

# The env files of the development and verification stack in $1. Existing files are kept and missing ones made;
# the database password is the one already in postgres.env when that file exists.
write_stack_env() {
  local dir="$1" password user db key content
  prepare_env_dir "$dir"
  if [ -f "$dir/postgres.env" ]; then
    password="$(env_value "$dir/postgres.env" POSTGRES_PASSWORD)"
  else
    password="$(random_secret)" || exit 1
  fi
  content="$(fill_env_example postgres "POSTGRES_PASSWORD=$password")" || exit 1
  publish_env_file "$dir" postgres.env "$content"
  user="$(env_value "$dir/postgres.env" POSTGRES_USER)"
  db="$(env_value "$dir/postgres.env" POSTGRES_DB)"
  content="$(fill_env_example server "DATABASE_URL=postgres://$user:$password@postgres:5432/$db")" || exit 1
  publish_env_file "$dir" server.env "$content"
  content="$(fill_env_example worker)" || exit 1
  publish_env_file "$dir" worker.env "$content"
  key="$(random_secret)" || exit 1
  content="$(fill_env_example n8n "N8N_ENCRYPTION_KEY=$key")" || exit 1
  publish_env_file "$dir" n8n.env "$content"
  content="$(fill_env_example s3)" || exit 1
  publish_env_file "$dir" s3.env "$content"
}

# Fails unless the value is a real secret: set, not a placeholder, as long as a generated one.
require_secret() {
  local what="$1" value="$2"
  [ -n "$value" ] || die "$what is missing"
  grep -qiE "$SECRET_PLACEHOLDERS" <<<"$value" && die "$what is a placeholder, not a secret"
  [ ${#value} -ge 32 ] || die "$what is shorter than a generated secret (32 characters)"
  return 0
}

# Checks the stack's env files in $1 before anything starts: owner-only, every secret set and real, and the
# database URL with the database's own password.
check_stack_env() {
  local dir="$1" name password url
  require_owner_only "$dir" 700
  for name in "${STACK_ENV_FILES[@]}"; do
    [ -f "$dir/$name.env" ] || die "$dir/$name.env is missing"
    require_owner_only "$dir/$name.env" 600
  done
  password="$(env_value "$dir/postgres.env" POSTGRES_PASSWORD)"
  require_secret "POSTGRES_PASSWORD in $dir/postgres.env" "$password"
  require_secret "N8N_ENCRYPTION_KEY in $dir/n8n.env" "$(env_value "$dir/n8n.env" N8N_ENCRYPTION_KEY)"
  url="$(env_value "$dir/server.env" DATABASE_URL)"
  [[ "$url" == *":$password@"* ]] || die "DATABASE_URL in $dir/server.env does not hold the password in $dir/postgres.env"
}

# --- Development stack (shared by local.sh and try-pr.sh) ---
DEV_PROJECT="n8n-ops-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/n8n-ops-dev"

dev_data_dir() {
  printf '%s' "${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
}

# A docker-compose-dev.yml copied before the stack generated its secrets names the tracked env files of then.
dev_compose_is_old() {
  [ -f "$DEV_COMPOSE_FILE" ] && grep -qE 'docker/(dev|n8n-dev|s3-dev)\.env' "$DEV_COMPOSE_FILE"
}

dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  # Before scripts/local.sh migrate, only what reads the running containers by project name works: the old copy
  # names env files that no longer exist.
  if dev_compose_is_old; then
    case "${1:-}" in
      # From / so Compose finds no file at all (from the repository it would read the production one) and acts on
      # the project's containers by their labels.
      down | logs | ps | stop) (cd / && docker compose -p "$DEV_PROJECT" "$@") ;;
      *) die "docker-compose-dev.yml names the env files of before the stack generated its secrets. Run once:
  scripts/local.sh migrate" ;;
    esac
    return
  fi
  local data
  data="$(dev_data_dir)"
  # DOCKER_SOCKET_GID only for docker-compose-dev.yml copies made before the socket proxy ran as root.
  N8N_OPS_DATA_DIR="$data" N8N_OPS_ENV_DIR="$data/env" N8N_OPS_IMAGE_TAG=dev DOCKER_SOCKET_GID="$(docker_socket_gid)" \
    docker compose -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}

# Before the development stack starts: makes its secrets on a fresh stack, checks them on one that has them, and
# stops on a stack that is not ready (an old docker-compose-dev.yml, a migration that did not finish, or secrets
# lost while its database is kept: new ones would not open that database).
require_dev_secrets() {
  local data env name complete=1
  data="$(dev_data_dir)"
  env="$data/env"
  dev_compose_is_old && die "docker-compose-dev.yml names the env files of before the stack generated its secrets. Run once:
  scripts/local.sh migrate"
  [ -e "$env/.rotate-postgres" ] && die "moving the development database to its new password did not finish. Run again:
  scripts/local.sh migrate"
  for name in "${STACK_ENV_FILES[@]}"; do
    [ -f "$env/$name.env" ] || complete=0
  done
  if [ $complete -eq 0 ] && [ -n "$(ls -A "$data/postgres" 2>/dev/null)" ]; then
    die "the secrets in $env are missing, but the database in $data/postgres is kept; new secrets would not open it.
Put $env back, or start over with scripts/local.sh nuke (deletes the development data)."
  fi
  write_stack_env "$env"
  check_stack_env "$env"
}

# Creates the stack's data directories. The server and worker images hand their own directories to
# their users when they start, so nothing is prepared for them. "pairing" is where the end-to-end
# tests leave the worker's pairing token.
prepare_data_dirs() {
  local dir="$1"
  mkdir -p "$dir/server" "$dir/postgres" "$dir/worker" "$dir/pairing" "$dir/backups"
}
