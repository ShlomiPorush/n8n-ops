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

# Builds the server and worker images with the given tag. Stops on the first failure.
build_images() {
  local tag="$1" version="${2:-$1}"
  require_docker
  local app
  for app in server worker; do
    info "Building n8n-ops-$app:$tag"
    docker build -f "$REPO_ROOT/docker/$app.Dockerfile" --build-arg "VERSION=$version" -t "n8n-ops-$app:$tag" "$REPO_ROOT" ||
      die "building n8n-ops-$app:$tag failed"
  done
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

# --- Development stack (shared by local.sh and try-pr.sh) ---
DEV_PROJECT="n8n-ops-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/n8n-ops-dev"

dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  # DOCKER_SOCKET_GID only for docker-compose-dev.yml copies made before the socket proxy ran as root.
  N8N_OPS_DATA_DIR="${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}" N8N_OPS_IMAGE_TAG=dev \
    DOCKER_SOCKET_GID="$(docker_socket_gid)" \
    docker compose -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}

# Creates the stack's data directories. The server and worker images hand their own directories to
# their users when they start, so nothing is prepared for them. "pairing" is where the end-to-end
# tests leave the worker's pairing token.
prepare_data_dirs() {
  local dir="$1"
  mkdir -p "$dir/server" "$dir/postgres" "$dir/worker" "$dir/pairing" "$dir/backups"
}
