#!/usr/bin/env bash
# Development stack: build images, start, stop, inspect, and reset.
# Usage: scripts/local.sh <build|up|start|down|status|logs|nuke>
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="$DEV_PROJECT"
export N8N_OPS_DATA_DIR="${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
# The socket proxy is checked on its own: it may run as root to open the Docker socket.
SERVICES=(server postgres worker)

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
  migrate  Once, for a stack made before it generated its own secrets: move it to them, keeping its data.

Data directory: $N8N_OPS_DATA_DIR
Secrets:        $N8N_OPS_DATA_DIR/env (generated once, owner-only; never in the repository)
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
  check_socket_proxy "$PROJECT"
}

# Once, for a development stack made before it generated its own secrets: points docker-compose-dev.yml at the
# generated env files, makes them, and moves the kept database to its new password. Resumes where a run stopped.
migrate() {
  local env="$N8N_OPS_DATA_DIR/env" marker="$N8N_OPS_DATA_DIR/env/.rotate-postgres" was_old=0 name complete=1
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing; nothing to migrate"
  if dev_compose_is_old; then
    was_old=1
    rewrite_compose_copy
  fi
  for name in "${STACK_ENV_FILES[@]}"; do
    [ -f "$env/$name.env" ] || complete=0
  done
  if [ -z "$(ls -A "$N8N_OPS_DATA_DIR/postgres" 2>/dev/null)" ]; then
    # No database yet: nothing to move.
    write_stack_env "$env"
    check_stack_env "$env"
    rm -f "$marker"
    info "Done; start the stack with: scripts/local.sh start"
    return
  fi
  if [ ! -e "$marker" ]; then
    if [ $complete -eq 1 ]; then
      info "Already migrated"
      return
    fi
    # Missing secrets with a kept database and no migration under way: they were lost, not never made.
    [ $was_old -eq 1 ] || die "the secrets in $env are missing, but the database is kept and no migration is under way.
Put $env back, or start over with scripts/local.sh nuke (deletes the development data)."
    prepare_env_dir "$env"
    : >"$marker"
  fi
  # From here a stopped run resumes: existing files are kept, missing ones made with the password already chosen.
  write_stack_env "$env"
  check_stack_env "$env"
  info "Moving the development database to its new password"
  compose up -d --wait --wait-timeout 120 postgres || die "the database did not start"
  # Over the local socket, which the official image trusts; the values come from the container's environment, so
  # the password is on no command line.
  # shellcheck disable=SC2016 # expands inside the container
  compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' ||
\getenv user POSTGRES_USER
\getenv pw POSTGRES_PASSWORD
ALTER ROLE :"user" PASSWORD :'pw';
SQL
    die "could not set the new database password; run scripts/local.sh migrate again"
  # A TCP login takes the password check, which the local socket skips.
  # shellcheck disable=SC2016 # expands inside the container
  compose exec -T postgres sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select 1"' >/dev/null ||
    die "the database does not take the new password; run scripts/local.sh migrate again"
  rm -f "$marker"
  info "Done. The development n8n starts again empty, with a new key. Start the stack with: scripts/local.sh start"
}

# Points each service of docker-compose-dev.yml at its generated env file and leaves every other line as it is. The
# copy before is kept beside it.
rewrite_compose_copy() {
  local backup="$DEV_COMPOSE_FILE.before-secrets" tmp
  [ -e "$backup" ] || cp -p "$DEV_COMPOSE_FILE" "$backup"
  tmp="$(mktemp "$DEV_COMPOSE_FILE.XXXXXX")"
  # shellcheck disable=SC2016 # ${N8N_OPS_ENV_DIR} is for Compose
  awk '
    /^services:/ { in_services = 1 }
    in_services && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { service = $1; sub(":", "", service) }
    /^[[:space:]]*env_file:[[:space:]]*docker\/(dev|n8n-dev|s3-dev)\.env[[:space:]]*$/ {
      if (service !~ /^(server|postgres|worker|n8n|s3)$/) { print "unknown service " service > "/dev/stderr"; exit 2 }
      indent = $0; sub(/env_file.*/, "", indent)
      print indent "env_file:"
      print indent "  - path: ${N8N_OPS_ENV_DIR:?N8N_OPS_ENV_DIR is set by the scripts}/" service ".env"
      print indent "    required: false"
      next
    }
    { print }
  ' "$DEV_COMPOSE_FILE" >"$tmp" || {
    rm -f "$tmp"
    die "could not rewrite docker-compose-dev.yml; it is unchanged"
  }
  mv "$tmp" "$DEV_COMPOSE_FILE"
  info "docker-compose-dev.yml now reads the generated env files; the copy before is $backup"
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
      require_dev_secrets
      compose up --remove-orphans
      ;;
    start)
      build
      prepare_data_dir
      require_dev_secrets
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
    migrate)
      prepare_data_dir
      migrate
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
