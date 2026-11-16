#!/usr/bin/env bash
# Run a pull request on the development stack without touching your checkout.
# Usage: scripts/try-pr.sh <number> [--any-author] | status | restore
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

  <number> [--any-author]
            Check out the pull request in a disposable worktree, back up the development database,
            rebuild only the affected images and restart only those services. PostgreSQL keeps running.
            Only a pull request opened by the repository's owner runs (checked with gh on github.com);
            --any-author runs one opened by someone else, after you have read its code.
  status    Show the active pull request and which images are running.
  restore   Put back the previous images and the database as it was before the pull request.

The development stack must be running (scripts/local.sh start), with the server, worker and
socket-proxy services of docker-compose-dev.yml as in docker/docker-compose-dev.example.yml.
Keep its n8n running while a pull request is active. Nothing is merged or pushed, and your
working tree is never changed.
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
  local shared='^(VERSION$|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|config/|packages/)'
  grep -qE "$shared|^(apps/server/|apps/web/|docker/server\.)" <<<"$files" && echo server
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

# "owner/name" of the GitHub repository origin points at, as git would fetch from it; empty for any other remote.
github_repo() {
  local url
  url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || return 0
  if [[ "$url" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]%.git}"
  fi
}

# The pull request was opened by the owner of the repository it was opened in, as GitHub says.
require_owner_author() {
  local pr="$1" repo record author owner two_names=$'^([^\t]+)\t([^\t]+)$'
  repo="$(github_repo)"
  [ -n "$repo" ] || die "origin is not a github.com repository, so who opened pull request #$pr cannot be checked.
To run it anyway, after reading its code: scripts/try-pr.sh $pr --any-author"
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is needed to check who opened pull request #$pr"
  # The host is named, so neither GH_HOST nor gh's default host can send the question to another server.
  record="$(gh api --hostname github.com "repos/$repo/pulls/$pr" --jq '[.user.login, .base.repo.owner.login] | @tsv')" ||
    die "could not read pull request #$pr of $repo from GitHub"
  [[ "$record" =~ $two_names ]] || die "GitHub did not say who opened pull request #$pr of $repo"
  author="${BASH_REMATCH[1]}" owner="${BASH_REMATCH[2]}"
  if [ "$author" != "$owner" ]; then
    die "pull request #$pr was opened by $author, not by the owner of $repo.
To run it anyway, after reading its code: scripts/try-pr.sh $pr --any-author"
  fi
}

# Pull request code runs in the server and worker, and reaches Docker only through the socket proxy, which lets it run
# commands only in the stack's own n8n. So the server and worker of docker-compose-dev.yml must be the template's
# (compared by Compose's configuration hash, with the stack's own settings), the running socket proxy must have been
# made from the template, and the one container it allows must be this stack's n8n. Docker container names are unique,
# so while that container exists no other can take its name.
require_stack_as_template() {
  local template="$REPO_ROOT/docker/docker-compose-dev.example.yml" copy expected labels
  local fix="Copy the server, worker and socket-proxy services from docker/docker-compose-dev.example.yml into
docker-compose-dev.yml, then run: scripts/local.sh start"
  copy="$(dev_compose config --hash server,worker | sort)" || die "could not read docker-compose-dev.yml"
  expected="$(
    DEV_COMPOSE_FILE="$template"
    dev_compose config --hash server,worker | sort
  )" || die "could not read docker/docker-compose-dev.example.yml"
  [ "$(wc -l <<<"$expected")" = 2 ] || die "could not read the server and worker of docker/docker-compose-dev.example.yml"
  [ "$copy" = "$expected" ] || die "the server or worker of docker-compose-dev.yml differ from the template's.
$fix"
  check_socket_proxy_config "$DEV_PROJECT" "$template" || die "the development stack's socket-proxy differs from the template's.
$fix"
  labels="$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}' \
    "$DEV_PROJECT-n8n-1" 2>/dev/null)" || die "$DEV_PROJECT-n8n-1 is not there. Run: scripts/local.sh start"
  [ "$labels" = "$DEV_PROJECT n8n" ] || die "$DEV_PROJECT-n8n-1 is not the development stack's n8n"
}

try_pr() {
  local pr="$1" option="${2:-}"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "pull request number expected, got: $pr"
  case "$option" in
    "" | --any-author) ;;
    *) die "unknown option: $option" ;;
  esac
  # Every check before anything is fetched or changed, so a refusal leaves nothing behind.
  [ ! -f "$STATE_FILE" ] || die "pull request $(grep '^PR=' "$STATE_FILE" | cut -d= -f2) is active. Run: scripts/try-pr.sh restore"
  [ "$option" = --any-author ] || require_owner_author "$pr"
  dev_compose ps --status running -q postgres | grep -q . || die "the development stack is not running. Run: scripts/local.sh start"
  require_stack_as_template
  require_dev_secrets

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
    docker build -f "$worktree/docker/$service.Dockerfile" \
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
  require_dev_secrets
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
    *)
      [ $# -le 2 ] || die "too many arguments. Run: scripts/try-pr.sh --help"
      try_pr "$@"
      ;;
  esac
}

main "$@"
