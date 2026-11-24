#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-try-pr-test.XXXXXX")" || exit 1
[ -d "$WORK" ] || exit 1
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

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
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
    [ "${*: -4}" = "config server worker socket-proxy" ] && { cat "$STATE/$side-render"; exit 0; }
    case "${*: -3}" in
      "config --hash socket-proxy") echo "socket-proxy $(cat "$STATE/$side-proxy")"; exit 0 ;;
      "running -q postgres") [ -f "$STATE/stack-up" ] && echo postgres-id; exit 0 ;;
    esac
    ;;
  ps)
    [ "${*: -1}" = label=com.docker.compose.service=socket-proxy ] && { echo proxy-id; exit 0; }
    ;;
  inspect)
    [ "${*: -1}" = proxy-id ] && { cat "$STATE/running-proxy"; [ -z "${MOCK_INSPECT_FAIL:-}" ]; exit; }
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
echo "gh $*" >>"$STATE/calls"
[ -n "${MOCK_GH_FAIL:-}" ] && { echo "HTTP 404: Not Found" >&2; exit 1; }
cat "$STATE/pr-record"
EOF
cat >"$WORK/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = -C ] && [ "\$3" = fetch ]; then
  echo "git fetch \${*:4}" >>"\$STATE/calls"
  exit 1
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gh" "$WORK/bin/git"

sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/repo/scripts/lib" "$WORK/case/repo/docker/env" "$WORK/case/home" "$WORK/case/data/mail-tls"
  export STATE="$WORK/case"
  local repo="$WORK/case/repo"
  cp "$REPO/scripts/try-pr.sh" "$repo/scripts/"
  cp "$REPO/scripts/lib/common.sh" "$repo/scripts/lib/"
  cp "$REPO/docker/docker-compose-dev.example.yml" "$repo/docker/"
  cp "$REPO/docker/docker-compose-dev.example.yml" "$repo/docker-compose-dev.yml"
  cp "$REPO"/docker/env/*.env.example "$repo/docker/env/"
  "$REAL_GIT" init --quiet "$repo"
  "$REAL_GIT" -C "$repo" remote add origin https://github.com/owner/n8n-ops.git
  chmod 700 "$WORK/case/data/mail-tls"
  echo cert >"$WORK/case/data/mail-tls/cert.pem"
  (umask 077 && echo key >"$WORK/case/data/mail-tls/key.pem")
  : >"$STATE/calls"
  touch "$STATE/stack-up"
  printf 'services:\n  server: {}\n  socket-proxy: {}\n  worker: {}\nnetworks:\n  docker-proxy:\n    internal: true\n' \
    >"$STATE/template-render"
  cp "$STATE/template-render" "$STATE/copy-render"
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
sed -i 's/  worker: {}/  worker: { volumes: [\/var\/run\/docker.sock:\/var\/run\/docker.sock] }/' "$STATE/copy-render"
run_try 7
check "a worker in docker-compose-dev.yml unlike the template's is refused" \
  said "the server, worker or socket-proxy of docker-compose-dev.yml differ from the template's"
check "  and says how to fix it" said "then run: scripts/local.sh start"
check "  before anything is fetched" not_fetched

sandbox
sed -i 's/  server: {}/  server: { privileged: true }/' "$STATE/copy-render"
run_try 7
check "a server in docker-compose-dev.yml unlike the template's is refused" not_fetched

sandbox
sed -i 's/internal: true/internal: false/' "$STATE/copy-render"
run_try 7
check "a socket proxy network in docker-compose-dev.yml unlike the template's is refused" not_fetched

sandbox
: >"$STATE/template-render"
: >"$STATE/copy-render"
run_try 7
check "a template whose services cannot be read is refused" not_fetched

sandbox
echo fff >"$STATE/running-proxy"
run_try 7
check "a running socket proxy not made from the template is refused" said "socket-proxy differs from the template's"
check "  before anything is fetched" not_fetched

sandbox
MOCK_INSPECT_FAIL=1 run_try 7
check "a socket proxy that cannot be inspected is refused, even when an answer was printed" \
  said "socket-proxy differs from the template's"
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
