#!/usr/bin/env bash
# Development stack: build images, start, stop, inspect, and reset.
# Usage: scripts/local.sh <build|up|start|down|status|logs|nuke>
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="$DEV_PROJECT"
export N8N_OPS_DATA_DIR="${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
SERVICES=(server postgres worker socket-proxy)

usage() {
  cat <<EOF
Usage: scripts/local.sh <command>

  build    Build the server and worker development images.
  up       Build, then start the stack in the foreground.
  start    Build, then start the stack in the background and verify it.
  down     Stop the stack. Data in \$N8N_OPS_DATA_DIR is kept.
  status   Show containers, health and runtime users.
  logs     Follow the logs.
  nuke     Stop the stack and delete its data directory (asks first).

Data directory: $N8N_OPS_DATA_DIR
EOF
}

compose() {
  dev_compose "$@"
}

prepare_data_dir() {
  prepare_data_dirs "$N8N_OPS_DATA_DIR"
}

build() {
  build_images dev "dev-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
}

status() {
  compose ps
  check_non_root "$PROJECT" "${SERVICES[@]}"
}

nuke() {
  local resolved
  resolved="$(realpath -m "$N8N_OPS_DATA_DIR")"
  case "$resolved" in
    "" | / | "$HOME" | "$REPO_ROOT") die "refusing to delete $resolved" ;;
  esac
  [[ "$(basename "$resolved")" == n8n-ops-dev* ]] || die "refusing to delete $resolved: the name must start with n8n-ops-dev"
  read -r -p "Delete the development stack and ALL data in $resolved? Type 'nuke' to confirm: " answer
  [ "$answer" = "nuke" ] || die "cancelled"
  compose down --remove-orphans
  remove_data_dir "$resolved"
  info "Deleted $resolved"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    build)
      build
      ;;
    up)
      build
      prepare_data_dir
      compose up --remove-orphans
      ;;
    start)
      build
      prepare_data_dir
      info "Starting $PROJECT"
      compose up -d --remove-orphans --wait --wait-timeout 120 || {
        compose ps
        die "the stack did not become healthy; see: scripts/local.sh logs"
      }
      status
      info "Ready: http://localhost:${N8N_OPS_PORT:-8080}"
      ;;
    down)
      compose down --remove-orphans
      ;;
    status)
      status
      ;;
    logs)
      compose logs -f
      ;;
    nuke)
      nuke
      ;;
    -h | --help | help | "")
      usage
      ;;
    *)
      usage
      die "unknown command: $cmd"
      ;;
  esac
}

require_docker
main "$@"
