#!/usr/bin/env bash
# Run a pull request on the development stack without touching your checkout.
# Usage: scripts/try-pr.sh <number> | status | restore
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

STATE_DIR="$CACHE_DIR/try-pr"
STATE_FILE="$STATE_DIR/state.env"
# Filled from STATE_FILE by load_state.
PR="" COMMIT="" WORKTREE="" REF="" SERVICES=""

usage() {
  cat <<'EOF'
Usage: scripts/try-pr.sh <command>

  <number>  Check out the pull request in a disposable worktree, back up the development database,
            rebuild only the affected images and restart only those services. PostgreSQL keeps running.
  status    Show the active pull request and which images are running.
  restore   Put back the previous images and the database as it was before the pull request.

The development stack must be running (scripts/local.sh start). Nothing is merged or pushed,
and your working tree is never changed.
EOF
}

load_state() {
  [ -f "$STATE_FILE" ] || die "no pull request is active"
  # shellcheck source=/dev/null
  source "$STATE_FILE"
}

db_env() {
  # shellcheck disable=SC2016 # expands inside the container
  dev_compose exec -T postgres sh -c 'echo "$POSTGRES_USER $POSTGRES_DB"'
}

affected_services() {
  local range="$1" files
  files="$(git -C "$REPO_ROOT" diff --name-only "$range")"
  local shared='^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|config/|packages/)'
  grep -qE "$shared|^(apps/server/|apps/web/|apps/web-compact/|docker/server\.)" <<<"$files" && echo server
  grep -qE "$shared|^(apps/worker/|docker/worker\.)" <<<"$files" && echo worker
  return 0
}

image_id() {
  docker image inspect -f '{{.Id}}' "$1"
}

running_image_id() {
  local cid
  cid="$(dev_compose ps -q "$1")"
  [ -n "$cid" ] || die "service $1 is not running"
  docker inspect -f '{{.Image}}' "$cid"
}

try_pr() {
  local pr="$1"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "pull request number expected, got: $pr"
  [ ! -f "$STATE_FILE" ] || die "pull request $(grep '^PR=' "$STATE_FILE" | cut -d= -f2) is active. Run: scripts/try-pr.sh restore"
  dev_compose ps --status running -q postgres | grep -q . || die "the development stack is not running. Run: scripts/local.sh start"

  mkdir -p "$STATE_DIR"
  local ref="refs/n8n-ops/try-pr/$pr" worktree="$STATE_DIR/worktree-$pr"
  info "Fetching pull request #$pr"
  git -C "$REPO_ROOT" fetch --quiet origin "+pull/$pr/head:$ref" || die "cannot fetch pull request #$pr"
  git -C "$REPO_ROOT" fetch --quiet origin main
  git -C "$REPO_ROOT" worktree add --quiet --detach "$worktree" "$ref"
  local commit
  commit="$(git -C "$worktree" rev-parse --short HEAD)"

  mapfile -t services < <(affected_services "origin/main...$ref")
  if [ ${#services[@]} -eq 0 ]; then
    git -C "$REPO_ROOT" worktree remove --force "$worktree"
    git -C "$REPO_ROOT" update-ref -d "$ref"
    info "Pull request #$pr changes no image. Nothing to run."
    return 0
  fi

  read -r db_user db_name < <(db_env)
  info "Backing up the development database"
  dev_compose exec -T postgres pg_dump -U "$db_user" -d "$db_name" -Fc >"$STATE_DIR/db-before.dump" ||
    die "database backup failed"

  local service
  for service in "${services[@]}"; do
    docker tag "n8n-ops-$service:dev" "n8n-ops-$service:try-pr-previous"
  done
  {
    echo "PR=$pr"
    echo "COMMIT=$commit"
    echo "WORKTREE=$worktree"
    echo "REF=$ref"
    echo "SERVICES=\"${services[*]}\""
  } >"$STATE_FILE"

  for service in "${services[@]}"; do
    info "Building n8n-ops-$service:dev from #$pr ($commit)"
    docker build -f "$worktree/docker/$service.Dockerfile" --build-arg "VERSION=pr$pr-$commit" \
      -t "n8n-ops-$service:dev" "$worktree" || die "build failed; run: scripts/try-pr.sh restore"
  done

  info "Restarting ${services[*]}"
  dev_compose up -d --no-deps --wait --wait-timeout 120 "${services[@]}" ||
    die "the pull request did not become healthy; inspect with scripts/local.sh logs, then run scripts/try-pr.sh restore"
  for service in "${services[@]}"; do
    [ "$(running_image_id "$service")" = "$(image_id "n8n-ops-$service:dev")" ] ||
      die "$service is not running the freshly built image"
  done
  check_non_root "$DEV_PROJECT" "${services[@]}"
  info "Pull request #$pr ($commit) is running. When done: scripts/try-pr.sh restore"
}

status() {
  if [ ! -f "$STATE_FILE" ]; then
    info "No pull request is active"
    return 0
  fi
  load_state
  info "Pull request #$PR ($COMMIT) is active; worktree $WORKTREE"
  local service
  for service in $SERVICES; do
    if [ "$(running_image_id "$service")" = "$(image_id "n8n-ops-$service:dev")" ]; then
      echo "    $service runs the pull request image"
    else
      echo "    $service does NOT run the pull request image"
    fi
  done
}

restore() {
  load_state
  local service
  info "Restoring images: $SERVICES"
  for service in $SERVICES; do
    docker tag "n8n-ops-$service:try-pr-previous" "n8n-ops-$service:dev"
  done
  # shellcheck disable=SC2086 # SERVICES is a space-separated list
  dev_compose stop $SERVICES

  read -r db_user db_name < <(db_env)
  info "Restoring the development database"
  dev_compose exec -T postgres dropdb -U "$db_user" --force --if-exists "$db_name"
  dev_compose exec -T postgres createdb -U "$db_user" "$db_name"
  dev_compose exec -T postgres pg_restore -U "$db_user" -d "$db_name" --no-owner <"$STATE_DIR/db-before.dump" ||
    die "database restore failed; the dump is kept at $STATE_DIR/db-before.dump"

  # shellcheck disable=SC2086 # SERVICES is a space-separated list
  dev_compose up -d --no-deps --wait --wait-timeout 120 $SERVICES || die "the restored stack did not become healthy"
  for service in $SERVICES; do
    docker rmi "n8n-ops-$service:try-pr-previous" >/dev/null
  done
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE"
  git -C "$REPO_ROOT" update-ref -d "$REF"
  rm -f "$STATE_FILE" "$STATE_DIR/db-before.dump"
  info "Restored the state from before pull request #$PR"
}

main() {
  require_docker
  case "${1:-}" in
    status) status ;;
    restore) restore ;;
    -h | --help | help | "") usage ;;
    *) try_pr "$1" ;;
  esac
}

main "$@"
