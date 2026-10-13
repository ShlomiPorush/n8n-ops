#!/usr/bin/env bash
# The single verification entry point, used locally, in CI and by the release workflow.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-guards] [--skip-integration]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="n8n-ops-verify"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble"
CHANGED_BASE=""
GUARDS=1
CHECKS=1
INTEGRATION=1

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)        Full sweep: guards, lint, types, unit tests, builds, integration and end-to-end tests.
  --changed [BASE]    Only packages changed since BASE (default origin/main) and their dependents.
                      Changes to shared root files, config or docker/ still run everything.
  --guards-only       Only the repository guards (language, Compose, shell scripts).
  --skip-guards       Everything except the guards.
  --skip-integration  Skip the container stack and end-to-end tests.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --changed)
      CHANGED_BASE="origin/main"
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then
        CHANGED_BASE="$2"
        shift
      fi
      ;;
    --guards-only) CHECKS=0 INTEGRATION=0 ;;
    --skip-guards) GUARDS=0 ;;
    --skip-integration) INTEGRATION=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown option: $1"
      ;;
  esac
  shift
done

changed_files() {
  local base
  base="$(git -C "$REPO_ROOT" merge-base "$CHANGED_BASE" HEAD)" || die "cannot find a merge base with $CHANGED_BASE"
  {
    git -C "$REPO_ROOT" diff --name-only "$base"
    git -C "$REPO_ROOT" ls-files --others --exclude-standard
  } | sort -u
}

run_guards() {
  info "Guards"
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain '
    set -euo pipefail
    fail=0

    hebrew="$(git ls-files -z -co --exclude-standard | xargs -0 grep -IlP "[\x{0590}-\x{05FF}]" -- 2>/dev/null || true)"
    if [ -n "$hebrew" ]; then
      echo "Hebrew text is not allowed in tracked files:"; echo "$hebrew"; fail=1
    fi

    compose_files="docker-compose.yml docker/docker-compose-dev.example.yml"
    [ -f docker-compose-dev.yml ] && compose_files="$compose_files docker-compose-dev.yml"
    # shellcheck disable=SC2086
    if grep -nE "^[[:space:]]*build[[:space:]]*:" $compose_files; then
      echo "Compose files must not contain build:. Images are built by the scripts."; fail=1
    fi

    mapfile -t scripts < <(git ls-files -co --exclude-standard "scripts/*.sh")
    shellcheck -x "${scripts[@]}" || fail=1
    shfmt -d -i 2 -ci "${scripts[@]}" || { echo "Run: shfmt -w -i 2 -ci scripts"; fail=1; }
    while read -r mode _ _ path; do
      [ "$mode" = 100755 ] || [ "$path" = scripts/lib/common.sh ] || { echo "$path is not executable"; fail=1; }
    done < <(git ls-files -s "scripts/*.sh")

    exit $fail
  ' || die "guards failed"
}

run_checks() {
  local filter=()
  if [ -n "$CHANGED_BASE" ]; then
    filter=(--filter "...[$CHANGED_BASE]")
  fi
  info "Install"
  install_deps
  info "Lint and format"
  in_toolchain "pnpm lint"
  info "Types, unit tests and builds${CHANGED_BASE:+ (changed since $CHANGED_BASE)}"
  in_toolchain "pnpm -r ${filter[*]:+${filter[*]@Q}} run typecheck \
    && pnpm -r ${filter[*]:+${filter[*]@Q}} run test \
    && pnpm -r ${filter[*]:+${filter[*]@Q}} --filter=./apps/* run build"
}

stack() {
  DOCKER_SOCKET_GID="$(docker_socket_gid)" N8N_OPS_IMAGE_TAG=verify N8N_OPS_PORT=0 \
    docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker/docker-compose-dev.example.yml" "$@"
}

cleanup_stack() {
  stack down --remove-orphans >/dev/null 2>&1 || true
  [ -n "${N8N_OPS_DATA_DIR:-}" ] && remove_data_dir "$N8N_OPS_DATA_DIR"
}

run_integration() {
  info "Integration: images and stack"
  build_images verify "verify-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  N8N_OPS_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-verify.XXXXXX")"
  export N8N_OPS_DATA_DIR
  mkdir -p "$N8N_OPS_DATA_DIR/server" "$N8N_OPS_DATA_DIR/postgres" "$N8N_OPS_DATA_DIR/worker"
  trap cleanup_stack EXIT
  stack up -d --remove-orphans --wait --wait-timeout 180 || {
    stack ps
    stack logs --tail 50
    die "the verification stack did not become healthy"
  }
  check_non_root "$PROJECT" server postgres worker

  info "Integration: health endpoint"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default")
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'body="$(node -e "fetch(\"http://server:8080/healthz/ready\").then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })")" && echo "    $body" && grep -q "\"database\":\"ok\"" <<<"$body"' ||
    die "server is not ready"
  TOOLCHAIN_EXTRA_ARGS=()

  info "End-to-end tests"
  docker run --rm --network "${PROJECT}_default" --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
    -e E2E_BASE_URL=http://server:8080 -v "$REPO_ROOT:/repo" -w /repo/apps/web \
    "$PLAYWRIGHT_IMAGE" node node_modules/@playwright/test/cli.js test || die "end-to-end tests failed"
}

main() {
  require_docker
  build_toolchain

  if [ -n "$CHANGED_BASE" ]; then
    mapfile -t files < <(changed_files)
    if [ ${#files[@]} -eq 0 ]; then
      info "No changes since $CHANGED_BASE"
      CHECKS=0 INTEGRATION=0
    elif printf '%s\n' "${files[@]}" | grep -qvE '^(docs/|README\.md$|AGENTS\.md$|CHANGELOG\.md$|LICENSE$)'; then
      # Shared root files, config or images: the package filter cannot see their consumers, so run everything.
      if printf '%s\n' "${files[@]}" | grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|biome\.json|config/|docker/|docker-compose\.yml|scripts/lib/)'; then
        info "Shared files changed: full sweep"
        CHANGED_BASE=""
      fi
    else
      info "Documentation-only change"
      CHECKS=0 INTEGRATION=0
    fi
  fi

  [ $GUARDS -eq 1 ] && run_guards
  if [ $CHECKS -eq 1 ]; then
    run_checks
  fi
  if [ $INTEGRATION -eq 1 ]; then
    # End-to-end tests need the web package's node_modules.
    [ $CHECKS -eq 1 ] || install_deps
    run_integration
  fi
  info "Verify passed"
}

main
