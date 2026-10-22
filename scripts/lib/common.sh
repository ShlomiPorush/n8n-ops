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
  N8N_OPS_DATA_DIR="${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}" N8N_OPS_IMAGE_TAG=dev \
    DOCKER_SOCKET_GID="$(docker_socket_gid)" \
    docker compose -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}

# Creates the stack's data directories. The server image hands its own directory to UID 1000 when
# it starts. The worker runs as UID 1000, which is not always the host user (CI runners use 1001),
# so its directory is handed to UID 1000 from a container.
prepare_data_dirs() {
  local dir="$1"
  mkdir -p "$dir/server" "$dir/postgres" "$dir/worker"
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" chown 1000:1000 /target/worker ||
    die "could not prepare $dir"
}
