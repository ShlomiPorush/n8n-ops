#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-update-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
PASSED=0

check() {
  local what="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $what"
    [ -f "$WORK/case/out" ] && sed 's/^/      | /' "$WORK/case/out"
  fi
}

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STATE/calls"
key() { printf '%s' "$1" | tr '/:' '__'; }
release() { printf '%s' "${VERSION:-$(sed -n 's/^VERSION=//p' .env)}"; }
image_for() { awk -v s="$1" '$1 == s { print $2 }' "$STATE/services" | sed "s/@V@/$(release)/"; }
label_in() { sed -n 's/.*index .Config.Labels "\([^"]*\)".*/\1/p' <<<"$1"; }
image_label() { sed -n "s/^$2=//p" "$STATE/images/$(key "$1")" 2>/dev/null; }
containers() {
  local f service image status health
  for f in "$STATE"/containers/*; do
    [ -f "$f" ] || continue
    read -r service image status health <"$f"
    [ "$service" = "$1" ] || continue
    [ -n "$2" ] || [ "$status" = running ] || continue
    basename "$f"
  done
}
start() {
  local id
  for id in $(containers "$1" all); do rm "$STATE/containers/$id"; done
  echo "$1 $(image_for "$1") running healthy" >"$STATE/containers/new-$1"
}
case "$1" in
  rollout)
    if [ "$2" = --help ]; then
      [ -n "${MOCK_OLD_ROLLOUT:-}" ] && { printf 'Usage: docker rollout [OPTIONS] SERVICE\n'; exit 0; }
      printf 'Usage: docker rollout [OPTIONS] SERVICE\n\n  -t, --timeout N\n      --wait-after-healthy N\n'
      exit 0
    fi
    start "${*: -1}"
    exit 0
    ;;
  image)
    [ "$2 $3" = "inspect -f" ] || { echo "unexpected docker $*" >&2; exit 2; }
    [ -f "$STATE/images/$(key "$5")" ] || { echo "Error: No such image: $5" >&2; exit 1; }
    printf '%s\n' "$(image_label "$5" "$(label_in "$4")")"
    exit 0
    ;;
  inspect | container)
    [ "$1" = container ] && shift
    [ "$1 $2" = "inspect -f" ] || { echo "unexpected docker $*" >&2; exit 2; }
    format="$3"
    shift 3
    for id in "$@"; do
      [ -f "$STATE/containers/$id" ] || { echo "Error: No such container: $id" >&2; exit 1; }
      read -r service image status health <"$STATE/containers/$id"
      case "$format" in
        *Config.Image*) echo "$image" ;;
        *State.Status*) echo "$status $health" ;;
        *Config.Labels*) printf '%s\n' "$(image_label "$image" "$(label_in "$format")")" ;;
        *) echo "unexpected docker inspect -f $format" >&2; exit 2 ;;
      esac
    done
    exit 0
    ;;
  compose) shift ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
case "$1" in
  config)
    echo "name: n8n-ops"
    echo "services:"
    while read -r service _; do
      printf '  %s:\n    image: %s\n' "$service" "$(image_for "$service")"
    done <"$STATE/services"
    ;;
  ps)
    shift
    all="" quiet="" names=()
    for arg in "$@"; do
      case "$arg" in
        -a) all=1 ;;
        -q) quiet=1 ;;
        -aq | -qa) all=1 quiet=1 ;;
        *) names+=("$arg") ;;
      esac
    done
    [ -n "$quiet" ] || { echo "NAME IMAGE STATUS"; exit 0; }
    containers "${names[0]}" "$all"
    ;;
  pull)
    shift
    for service in "$@"; do
      [ -f "$STATE/images/$(key "$(image_for "$service")")" ] || { echo "manifest unknown: $(image_for "$service")" >&2; exit 1; }
    done
    ;;
  up) start "${*: -1}" ;;
  exec)
    id="$(containers "$5" "" | head -n 1)"
    read -r _ image _ <"$STATE/containers/$id"
    image_label "$image" org.opencontainers.image.version
    echo
    ;;
  *) echo "unexpected docker compose $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$WORK/bin/docker"

SERVER="ghcr.io/shlomiporush/n8n-ops"
WORKER="ghcr.io/shlomiporush/n8n-ops-worker"

deployment() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/images" "$WORK/case/containers" "$WORK/case/deploy"
  export STATE="$WORK/case"
  : >"$STATE/calls"
  cp "$REPO/scripts/update.sh" "$STATE/deploy/"
  printf 'name: n8n-ops\n' >"$STATE/deploy/docker-compose.yml"
  printf 'DOMAIN=ops.example.com\nVERSION=%s\nTZ=UTC\n' "$1" >"$STATE/deploy/.env"
  cp "$STATE/deploy/.env" "$STATE/env.before"
  printf 'server %s:@V@\nworker %s:@V@\npostgres postgres:17\n' "$SERVER" "$WORKER" >"$STATE/services"
}

server_image() {
  printf 'org.opencontainers.image.version=%s\nn8n-ops.rollout-from=%s\n' "$2" "$3" >"$STATE/images/$(printf '%s' "$SERVER:$1" | tr '/:' '__')"
}

worker_image() {
  printf 'org.opencontainers.image.version=%s\n' "$1" >"$STATE/images/$(printf '%s' "$WORKER:$1" | tr '/:' '__')"
}

container() {
  echo "$1 $2 $3 $4" >"$STATE/containers/$1-$(find "$STATE/containers" -type f | wc -l)"
}

standard() {
  deployment "$1"
  server_image "$1" "$1" "$1"
  server_image "$2" "$2" "$3"
  worker_image "$1"
  worker_image "$2"
  container server "$SERVER:$1" running healthy
  container worker "$WORKER:$1" running healthy
}

without_worker() {
  sed -i '/^worker /d' "$STATE/services"
  rm -f "$STATE"/containers/worker-*
}

update() {
  (cd "$STATE/deploy" && env -u VERSION PATH="$WORK/bin:$PATH" bash update.sh "$@") >"$STATE/out" 2>&1
}

said() { grep -qF -- "$1" "$STATE/out"; }
not_said() { ! said "$1"; }
called() { grep -qxF -- "$1" "$STATE/calls"; }
not_called() { ! called "$1"; }
line_of() { grep -nxF -- "$1" "$STATE/calls" | head -n 1 | cut -d : -f 1; }
env_kept() { cmp -s "$STATE/env.before" "$STATE/deploy/.env"; }
env_is() { [ "$(cat "$STATE/deploy/.env")" = "$(printf 'DOMAIN=ops.example.com\nVERSION=%s\nTZ=UTC' "$1")" ]; }
nothing_rolled() { ! grep -qE "^docker (rollout --timeout|compose up)" "$STATE/calls"; }

refused() {
  local status="$1" what="$2" reason="$3"
  check "$what: the run stops" [ "$status" -ne 0 ]
  check "  and says '$reason'" said "$reason"
  check "  and points to the update with downtime" said "update with downtime in docs/deploy.md"
  check "  and leaves .env as it was" env_kept
  check "  and rolls and starts nothing" nothing_rolled
}

standard 0.20.0 0.21.0 0.20.0
update 0.21.0
check "a release that may run beside the running one rolls out" [ $? -eq 0 ]
check "  the server with --wait-after-healthy 3" called "docker rollout --timeout 180 --wait-after-healthy 3 server"
check "  then the worker the same way" called "docker rollout --timeout 180 --wait-after-healthy 3 worker"
check "  server first" [ "$(line_of "docker rollout --timeout 180 --wait-after-healthy 3 server")" -lt "$(line_of "docker rollout --timeout 180 --wait-after-healthy 3 worker")" ]
check "  sets VERSION in .env and keeps its other lines" env_is 0.21.0
check "  and reads the version the server reports" said "server reports version 0.21.0"

standard 0.20.0 0.21.0 0.20.0
printf 'DOMAIN=ops.example.com\nVERSION=0.21.0\nTZ=UTC\n' >"$STATE/deploy/.env"
update
check "without a version it rolls to the VERSION in .env" [ $? -eq 0 ]
check "  with --wait-after-healthy 3" called "docker rollout --timeout 180 --wait-after-healthy 3 server"

standard 0.10.0 0.11.0 0.9.0
update 0.11.0
check "versions compare by number: 0.11.0 may run beside 0.10.0 from 0.9.0" [ $? -eq 0 ]
check "  and the server is rolled" called "docker rollout --timeout 180 --wait-after-healthy 3 server"
check "  and .env has the new release" env_is 0.11.0

standard 0.20.0 0.21.0 0.21.0
update 0.21.0
refused $? "the running release is older than rollout-from" "may run only beside 0.21.0"

standard 0.20.0 0.21.0 ""
update 0.21.0
refused $? "the new image has no rollout-from label" "no n8n-ops.rollout-from label"

standard 0.20.0 0.21.0 0.20.0
server_image 0.21.0 0.21.1 0.20.0
update 0.21.0
refused $? "the new image says another version" "is version 0.21.1, not 0.21.0"

standard 0.20.0 0.21.0 0.20.0
server_image 0.21.0 "" 0.20.0
update 0.21.0
refused $? "the new image has no version label" "is version unknown, not 0.21.0"

standard 0.10.0 0.9.0 0.9.0
update 0.9.0
check "a downgrade: the run stops" [ $? -ne 0 ]
check "  and says to restore the database backup instead" said "restore the n8n-ops database backup into the earlier release"
check "  and does not point to the update with downtime" not_said "update with downtime"
check "  and leaves .env as it was" env_kept
check "  and rolls and starts nothing" nothing_rolled

standard 0.21.0 0.21.0 ""
without_worker
update 0.21.0
check "the server already runs the release, whose image has no rollout-from: the run succeeds" [ $? -eq 0 ]
check "  and says it is already running" said "server is already running 0.21.0"

standard 0.21.0 0.21.0 0.21.0
without_worker
update 0.21.0
check "the server already runs the release: the run succeeds" [ $? -eq 0 ]
check "  and says it is already running" said "server is already running 0.21.0"
check "  and rolls nothing" nothing_rolled
check "  and leaves .env as it was" env_kept

standard 0.21.0 0.21.0 0.21.0
update
check "the server already runs the release beside a worker: the run succeeds" [ $? -eq 0 ]
check "  without rolling the server" not_called "docker rollout --timeout 180 --wait-after-healthy 3 server"
check "  and rolls the worker" called "docker rollout --timeout 180 --wait-after-healthy 3 worker"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/server-*
container server "$SERVER:0.20.0" exited unhealthy
update 0.21.0
refused $? "a stopped server" "server is stopped"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/server-*
update 0.21.0
refused $? "a server without a container" "server has no container"

standard 0.20.0 0.21.0 0.20.0
container server "$SERVER:0.20.0" running healthy
update 0.21.0
refused $? "two running server containers" "server has 2 containers, not one"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/server-*
container server "$SERVER:0.20.0" running unhealthy
update 0.21.0
refused $? "an unhealthy server" "health is unhealthy"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/server-*
container server "$SERVER:0.20.0" running starting
update 0.21.0
refused $? "a server still starting" "health is starting"

standard 0.20.0 0.21.0 0.20.0
server_image 0.20.0 "" ""
update 0.21.0
refused $? "a server on an unknown version" "server runs an unknown version"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/worker-*
container worker "$WORKER:0.20.0" exited none
update 0.21.0
check "a stopped worker: the run succeeds" [ $? -eq 0 ]
check "  and starts the worker" called "docker compose up -d --no-deps --wait --wait-timeout 180 worker"
check "  after rolling the server" called "docker rollout --timeout 180 --wait-after-healthy 3 server"

standard 0.20.0 0.21.0 0.20.0
rm "$STATE"/containers/worker-*
update 0.21.0
check "a worker without a container: the run succeeds" [ $? -eq 0 ]
check "  and starts the worker" called "docker compose up -d --no-deps --wait --wait-timeout 180 worker"

standard 0.20.0 0.21.0 0.20.0
container worker "$WORKER:0.20.0" exited none
update 0.21.0
check "a stopped worker container beside a running one stops the run" [ $? -ne 0 ]
check "  and says how to remove it" said "docker compose rm -f worker"
check "  and leaves .env as it was" env_kept
check "  and rolls nothing" nothing_rolled

standard 0.20.0 0.21.0 0.20.0
MOCK_OLD_ROLLOUT=1 update 0.21.0
check "a docker rollout without --wait-after-healthy stops the run" [ $? -ne 0 ]
check "  and says so" said "too old to know --wait-after-healthy"
check "  and leaves .env as it was" env_kept
check "  and rolls nothing" nothing_rolled

echo "update.sh: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
