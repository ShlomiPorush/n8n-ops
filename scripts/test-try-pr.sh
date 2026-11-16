#!/usr/bin/env bash
# Tests for the checks scripts/try-pr.sh makes before it fetches a pull request: who opened it (asked of GitHub with
# gh) and whether the development stack runs the template's server, worker and socket proxy. Real git and the real
# scripts in a scratch repository; docker and gh are stand-ins that answer from files and fail on anything else, and
# fetching is recorded instead of done. Run by scripts/verify.sh (guards).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-try-pr-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
REAL_GIT="$(command -v git)"
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

# --- stand-ins -------------------------------------------------------------------------------

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Docker stand-in: answers what the checks ask from files in $STATE.
echo "docker $*" >>"$STATE/calls"
case "$1" in
  info) exit 0 ;;
  compose)
    file="" prev=""
    for arg in "$@"; do
      [ "$prev" = -f ] && file="$arg"
      prev="$arg"
    done
    case "$file" in
      */docker/docker-compose-dev.example.yml) side=template ;;
      */docker-compose-dev.yml) side=copy ;;
      *) echo "unexpected compose file $file" >&2; exit 2 ;;
    esac
    case "${*: -3}" in
      "config --hash server,worker") cat "$STATE/$side-hashes"; exit 0 ;;
      "config --hash socket-proxy") echo "socket-proxy $(cat "$STATE/$side-proxy")"; exit 0 ;;
      "running -q postgres") [ -f "$STATE/stack-up" ] && echo postgres-id; exit 0 ;;
    esac
    ;;
  ps)
    [ "${*: -1}" = label=com.docker.compose.service=socket-proxy ] && { echo proxy-id; exit 0; }
    ;;
  inspect)
    [ "${*: -1}" = proxy-id ] && { cat "$STATE/running-proxy"; exit 0; }
    ;;
  container)
    if [ "$2" = inspect ] && [ "${*: -1}" = n8n-ops-dev-n8n-1 ]; then
      [ -f "$STATE/n8n-labels" ] || { echo "Error: No such container: n8n-ops-dev-n8n-1" >&2; exit 1; }
      cat "$STATE/n8n-labels"
      exit 0
    fi
    ;;
esac
echo "unexpected docker $*" >&2
exit 2
EOF
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# gh stand-in: the pull request record, as gh prints it with the --jq the script passes.
echo "gh $*" >>"$STATE/calls"
[ -n "${MOCK_GH_FAIL:-}" ] && { echo "HTTP 404: Not Found" >&2; exit 1; }
cat "$STATE/pr-record"
EOF
# Real git, except that fetching is only recorded and then fails, so a run that gets there stops.
cat >"$WORK/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = -C ] && [ "\$3" = fetch ]; then
  echo "git fetch \${*:4}" >>"\$STATE/calls"
  exit 1
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gh" "$WORK/bin/git"

# --- sandbox ---------------------------------------------------------------------------------

# A scratch repository with the scripts and the template, origin on github.com, and a stack that matches the
# template, opened by the owner; each case changes one thing.
sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/repo/scripts/lib" "$WORK/case/repo/docker/env" "$WORK/case/home" "$WORK/case/data/mail-tls"
  export STATE="$WORK/case"
  local repo="$WORK/case/repo"
  cp "$REPO/scripts/try-pr.sh" "$repo/scripts/"
  cp "$REPO/scripts/lib/common.sh" "$repo/scripts/lib/"
  # There is no Docker socket here; the stand-in needs no group.
  echo 'docker_socket_gid() { echo 0; }' >>"$repo/scripts/lib/common.sh"
  cp "$REPO/docker/docker-compose-dev.example.yml" "$repo/docker/"
  cp "$REPO/docker/docker-compose-dev.example.yml" "$repo/docker-compose-dev.yml"
  cp "$REPO"/docker/env/*.env.example "$repo/docker/env/"
  "$REAL_GIT" init --quiet "$repo"
  "$REAL_GIT" -C "$repo" remote add origin https://github.com/owner/n8n-ops.git
  # A mail certificate already made, so the stack's own checks pass without the toolchain image.
  chmod 700 "$WORK/case/data/mail-tls"
  echo cert >"$WORK/case/data/mail-tls/cert.pem"
  (umask 077 && echo key >"$WORK/case/data/mail-tls/key.pem")
  : >"$STATE/calls"
  touch "$STATE/stack-up"
  printf 'server aaa\nworker bbb\n' >"$STATE/template-hashes"
  printf 'worker bbb\nserver aaa\n' >"$STATE/copy-hashes"
  echo ccc >"$STATE/template-proxy"
  echo ccc >"$STATE/running-proxy"
  echo "n8n-ops-dev n8n" >"$STATE/n8n-labels"
  printf 'owner\towner\n' >"$STATE/pr-record"
}

run_try() {
  (cd "$WORK/case/repo" && PATH="$WORK/bin:$PATH" HOME="$WORK/case/home" XDG_CACHE_HOME="$WORK/case/home/cache" \
    XDG_DATA_HOME="$WORK/case/home/data" N8N_OPS_DATA_DIR="$WORK/case/data" GH_HOST=ghe.example.com GH_REPO=other/repo \
    bash scripts/try-pr.sh "$@") >"$WORK/case/out" 2>&1
}

said() { grep -q -- "$1" "$WORK/case/out"; }
fetched() { grep -q "^git fetch" "$STATE/calls"; }
not_fetched() { ! fetched; }
asked_github() { grep -q "^gh " "$STATE/calls"; }
not_asked_github() { ! asked_github; }
no_compose() { ! grep -q "^docker compose" "$STATE/calls"; }

# --- cases -----------------------------------------------------------------------------------

sandbox
run_try 7
check "the owner's pull request on a stack like the template passes every check and is fetched" fetched
check "  GitHub is asked about that pull request on github.com" \
  grep -q "^gh api --hostname github.com repos/owner/n8n-ops/pulls/7 " "$STATE/calls"

sandbox
"$REAL_GIT" -C "$WORK/case/repo" remote set-url origin git@github.com:owner/n8n-ops.git
run_try 7
check "an ssh origin on github.com is checked the same way" \
  grep -q "^gh api --hostname github.com repos/owner/n8n-ops/pulls/7 " "$STATE/calls"
check "  and the pull request is fetched" fetched

sandbox
printf 'someone\towner\n' >"$STATE/pr-record"
run_try 7
check "a pull request opened by someone else is refused" said "opened by someone, not by the owner of owner/n8n-ops"
check "  and says how to run it anyway" said "scripts/try-pr.sh 7 --any-author"
check "  before anything is fetched" not_fetched
check "  or the stack is read" no_compose

sandbox
printf 'someone\towner\n' >"$STATE/pr-record"
run_try 7 --any-author
check "--any-author runs a pull request opened by someone else" fetched
check "  without asking GitHub" not_asked_github

sandbox
MOCK_GH_FAIL=1 run_try 7
check "a pull request GitHub cannot be asked about is refused" said "could not read pull request #7"
check "  before anything is fetched" not_fetched

sandbox
printf '\towner\n' >"$STATE/pr-record"
run_try 7
check "an empty author is refused" said "GitHub did not say who opened pull request #7"
check "  before anything is fetched" not_fetched

sandbox
printf 'owner\n' >"$STATE/pr-record"
run_try 7
check "an answer with one name is refused" said "GitHub did not say who opened pull request #7"
check "  before anything is fetched" not_fetched

sandbox
printf '\t\n' >"$STATE/pr-record"
run_try 7
check "an empty answer is refused" not_fetched

sandbox
"$REAL_GIT" -C "$WORK/case/repo" remote set-url origin https://git.example.com/owner/n8n-ops.git
run_try 7
check "an origin outside github.com is refused" said "origin is not a github.com repository"
check "  without asking GitHub" not_asked_github
check "  before anything is fetched" not_fetched

sandbox
run_try 7 --force
check "an unknown option is refused" said "unknown option: --force"
check "  without asking GitHub" not_asked_github
check "  before anything is fetched" not_fetched

sandbox
run_try 7 --any-author extra
check "a third argument is refused" said "too many arguments"
check "  before anything is fetched" not_fetched

sandbox
mkdir -p "$WORK/case/home/cache/n8n-ops/try-pr"
echo "PR=5" >"$WORK/case/home/cache/n8n-ops/try-pr/state.env"
run_try 7
check "while another pull request is active, it is refused" said "pull request 5 is active"
check "  without asking GitHub" not_asked_github
check "  before anything is fetched" not_fetched

sandbox
printf 'server aaa\nworker ddd\n' >"$STATE/copy-hashes"
run_try 7
check "a worker in docker-compose-dev.yml unlike the template's is refused" \
  said "the server or worker of docker-compose-dev.yml differ from the template's"
check "  and says how to fix it" said "then run: scripts/local.sh start"
check "  before anything is fetched" not_fetched

sandbox
printf 'server eee\nworker bbb\n' >"$STATE/copy-hashes"
run_try 7
check "a server in docker-compose-dev.yml unlike the template's is refused" not_fetched

sandbox
: >"$STATE/template-hashes"
: >"$STATE/copy-hashes"
run_try 7
check "a template whose services cannot be read is refused" not_fetched

sandbox
echo fff >"$STATE/running-proxy"
run_try 7
check "a running socket proxy not made from the template is refused" said "socket-proxy differs from the template's"
check "  before anything is fetched" not_fetched

sandbox
: >"$STATE/running-proxy"
: >"$STATE/template-proxy"
run_try 7
check "an empty socket proxy hash is refused" not_fetched

sandbox
rm "$STATE/n8n-labels"
run_try 7
check "without the stack's n8n container it is refused" said "n8n-ops-dev-n8n-1 is not there"
check "  before anything is fetched" not_fetched

sandbox
echo "n8n-ops n8n" >"$STATE/n8n-labels"
run_try 7
check "a container of another project under the stack's n8n name is refused" \
  said "n8n-ops-dev-n8n-1 is not the development stack's n8n"
check "  before anything is fetched" not_fetched

sandbox
rm "$STATE/stack-up"
run_try 7
check "a stack that is not running is refused" said "the development stack is not running"
check "  before anything is fetched" not_fetched

sandbox
printf 'someone\towner\n' >"$STATE/pr-record"
run_try status
check "status needs none of the checks" said "No pull request is active"
check "  and asks GitHub nothing" not_asked_github

echo "try-pr.sh checks: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
