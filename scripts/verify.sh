#!/usr/bin/env bash
# The single verification entry point, used locally, in CI and by the release workflow.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-guards] [--skip-integration] [--design NAME]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="n8n-ops-verify"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
CHANGED_BASE=""
GUARDS=1
CHECKS=1
INTEGRATION=1
DESIGNS=(regular compact)

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)        Full sweep: guards, lint, types, unit tests, builds, integration and end-to-end tests.
  --changed [BASE]    Only packages changed since BASE (default origin/main) and their dependents.
                      Changes to shared root files, config or docker/ still run everything.
  --guards-only       Only the repository guards (language, Compose, shell scripts).
  --skip-guards       Everything except the guards.
  --skip-integration  Skip the container stack and end-to-end tests.
  --design NAME       End-to-end tests in one design only (regular or compact); CI runs each in its own job.
                      Without it they run once per design.
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
    --design)
      case "${2:-}" in
        regular | compact) DESIGNS=("$2") ;;
        *)
          usage
          die "--design needs regular or compact"
          ;;
      esac
      shift
      ;;
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

    bash scripts/test-release.sh || fail=1

    # Scripts inside the images run with plain POSIX sh.
    mapfile -t image_scripts < <(git ls-files -co --exclude-standard "docker/*.sh")
    shellcheck -s sh "${image_scripts[@]}" || fail=1
    shfmt -d -ln posix -i 2 -ci "${image_scripts[@]}" || { echo "Run: shfmt -w -ln posix -i 2 -ci docker/*.sh"; fail=1; }
    while read -r mode _ _ path; do
      [ "$mode" = 100755 ] || { echo "$path is not executable"; fail=1; }
    done < <(git ls-files -s "docker/*.sh")

    # The shell versions of the agent skill run with plain POSIX sh.
    skill=(packages/skill/n8n-ops/scripts/n8n-ops packages/skill/n8n-ops/scripts/n8n-ops.sh)
    shellcheck -s sh "${skill[@]}" || fail=1
    shfmt -d -ln posix -i 2 -ci "${skill[@]}" || { echo "Run: shfmt -w -ln posix -i 2 -ci ${skill[*]}"; fail=1; }
    while read -r mode _ _ path; do
      [ "$mode" = 100755 ] || { echo "$path is not executable"; fail=1; }
    done < <(git ls-files -s "${skill[@]}")

    exit $fail
  ' || die "guards failed"
}

run_checks() {
  local filter=()
  if [ -n "$CHANGED_BASE" ]; then
    # Never the root package: its scripts run the same script in every package, so a root file such as
    # CHANGELOG.md would build apps/web twice at once into the same dist. Shared root files already
    # force a full sweep (main), so nothing is left unchecked.
    filter=(--filter "...[$CHANGED_BASE]" --filter "!n8n-ops")
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
  N8N_OPS_IMAGE_TAG=verify N8N_OPS_PORT=0 \
    docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker/docker-compose-dev.example.yml" "$@"
}

cleanup_stack() {
  stack down --remove-orphans >/dev/null 2>&1 || true
  # After the last round the data is already gone; the exit trap must not turn that into a failure.
  if [ -n "${N8N_OPS_DATA_DIR:-}" ]; then
    remove_data_dir "$N8N_OPS_DATA_DIR"
  fi
}

# Stops the stack, confirms nothing of it still runs, and removes its data, so the next round starts fresh.
stop_stack() {
  stack down --remove-orphans || die "the verification stack did not stop"
  [ -z "$(stack ps -q)" ] || die "the verification stack still runs after stopping it"
  remove_data_dir "$N8N_OPS_DATA_DIR"
  unset N8N_OPS_DATA_DIR
}

start_stack() {
  N8N_OPS_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-verify.XXXXXX")"
  export N8N_OPS_DATA_DIR
  prepare_data_dirs "$N8N_OPS_DATA_DIR"
  stack up -d --remove-orphans --wait --wait-timeout 180 || {
    stack ps
    stack logs --tail 50
    die "the verification stack did not become healthy"
  }
  check_non_root "$PROJECT" server postgres worker
  check_socket_proxy "$PROJECT"
}

# Stores the design in the fresh database and restarts the server to read it, so even first-run setup
# shows that design.
seed_design() {
  local design="$1"
  # shellcheck disable=SC2016 # expands inside the container
  stack exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$0"' \
    "insert into settings (key, value) values ('general', '{\"publicUrl\":\"\",\"timezone\":\"UTC\",\"design\":\"$design\"}')
     on conflict (key) do update set value = settings.value || '{\"design\":\"$design\"}'::jsonb" ||
    die "could not store the $design design"
  if ! stack restart server >/dev/null || ! stack up -d --wait --wait-timeout 120 server; then
    die "the server did not come back after storing the design"
  fi
}

run_checks_on_stack() {
  info "Integration: health endpoint"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PROJECT}_default")
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'body="$(node -e "fetch(\"http://server:8080/healthz/ready\").then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })")" && echo "    $body" && grep -q "\"database\":\"ok\"" <<<"$body"' ||
    die "server is not ready"
  TOOLCHAIN_EXTRA_ARGS=()

  info "Integration: the socket proxy allows only what the worker needs"
  # From inside the worker: ping passes; listing containers and exec in another container are refused.
  local probe='const p = (m, path) => fetch("http://socket-proxy:2375" + path, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined }).then((r) => r.status);
(async () => {
  const got = [await p("GET", "/v1.43/_ping"), await p("GET", "/v1.43/containers/json"), await p("POST", "/v1.43/containers/'"${PROJECT}"'-postgres-1/exec")];
  console.log("    ping, list, exec in postgres:", got.join(", "));
  process.exit(got[0] === 200 && got[1] === 403 && got[2] === 403 ? 0 : 1);
})()'
  stack exec -T -u node worker node -e "$probe" || die "the socket proxy does not enforce its allowlist"

  info "Integration: the proxy check refuses a proxy that may gain privileges"
  # The same container with the setting on passes, so the refusal is for that setting alone.
  local fake value outcome
  for value in true false; do
    fake="$(docker run -d --rm --label "com.docker.compose.project=${PROJECT}-fake" \
      --label com.docker.compose.service=socket-proxy --cap-drop ALL --read-only \
      --security-opt "no-new-privileges:$value" "$TOOLCHAIN_IMAGE" sleep 60)"
    if (check_socket_proxy "${PROJECT}-fake") >/dev/null 2>&1; then outcome=passed; else outcome=refused; fi
    docker rm -f "$fake" >/dev/null
    echo "    no-new-privileges:$value $outcome"
    case "$value:$outcome" in
      true:passed | false:refused) ;;
      *) die "check_socket_proxy got no-new-privileges:$value wrong" ;;
    esac
  done

  info "Integration: the worker joins the group of the socket it uses, and only that one"
  # Runs the worker image's entrypoint with the host's socket mounted, as the generated compose
  # does without the proxy, and reads the groups the worker would run with.
  local gid groups expect setting name mount env got envs
  gid="$(stat -c %g /var/run/docker.sock)"
  [ "$gid" != 1000 ] || die "the Docker socket's group is 1000, the worker's own; this check cannot tell them apart"
  for setting in "default|/var/run/docker.sock||yes" "proxy|/var/run/docker.sock|DOCKER_HOST=tcp://socket-proxy:2375|no" \
    "unix|/custom.sock|DOCKER_HOST=unix:///custom.sock|yes" "bare|/custom.sock|DOCKER_HOST=/custom.sock|yes"; do
    IFS='|' read -r name mount env expect <<<"$setting"
    envs=()
    [ -z "$env" ] || envs=(-e "$env")
    groups="$(docker run --rm -v "/var/run/docker.sock:$mount" "${envs[@]}" n8n-ops-worker:verify \
      sh -c 'awk "/^Groups/ { \$1 = \"\"; print }" /proc/self/status')"
    if grep -qw "$gid" <<<"$groups"; then got=yes; else got=no; fi
    echo "    $name: groups$groups (socket group $gid: $got)"
    [ "$got" = "$expect" ] || die "the worker entrypoint gives the wrong groups for $name"
  done
}

# One end-to-end round per design, each on a fresh stack. Both designs are one app with the same functions,
# so the same suite runs in each and must pass in each; only the look differs.
run_e2e_round() {
  local design="$1" app="$2"
  info "End-to-end tests: $design design"
  start_stack
  [ "$design" = regular ] || seed_design "$design"
  run_checks_on_stack
  # The alias lets the server reach the stand-in Telegram Bot API that the tests run (TELEGRAM_API_URL).
  docker run --rm --network "${PROJECT}_default" --network-alias e2e-runner \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e E2E_DESIGN="$design" \
    -e E2E_BASE_URL=http://server:8080 -e E2E_N8N_CONTAINER="${PROJECT}-n8n-1" \
    -v "$N8N_OPS_DATA_DIR/pairing:/worker-data" -v "$REPO_ROOT:/repo" -w "/repo/$app" \
    "$PLAYWRIGHT_IMAGE" node node_modules/@playwright/test/cli.js test || {
    stack logs --tail 60 server worker
    die "end-to-end tests failed ($design design)"
  }
  stop_stack
}

run_integration() {
  info "Integration: images and stack"
  build_images verify "verify-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  # Telegram calls go to the stand-in Bot API inside the end-to-end test runner, never to Telegram.
  export TELEGRAM_API_URL="http://e2e-runner:8099"
  trap cleanup_stack EXIT
  local design
  for design in "${DESIGNS[@]}"; do
    run_e2e_round "$design" apps/web
  done
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
