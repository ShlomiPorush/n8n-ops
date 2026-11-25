#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-discover-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FIXTURES="$WORK/containers"
REPORT="$WORK/report.txt"
FAILED=0
PASSED=0
H=()
for i in $(seq 26); do
  H[i]="v$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
done
LF=$'\n'

check() {
  local what="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $what"
  fi
}

absent() {
  ! grep -qF -- "$1" "$REPORT"
}

container() {
  local dir="$FIXTURES/$1"
  mkdir -p "$dir"
  printf '%s\n' "$2" >"$dir/image"
  [ "$3" = null ] || printf '%s' "$3" >"$dir/entrypoint"
  [ "$4" = null ] || printf '%s' "$4" >"$dir/cmd"
  [ -z "${5:-}" ] || printf '%s\n' "$5" >"$dir/mode"
  : >"$dir/env"
}

env_of() {
  local name="$1"
  shift
  printf '%s\0' "$@" >"$FIXTURES/$name/env"
}

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
set +x
case "$1" in
  version | system | network) exit 0 ;;
  ps)
    [ "${4:-}" = '{{.Names}}' ] && ls "$FIXTURES"
    exit 0
    ;;
  inspect) ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
[ "$2" = -f ] && [ $# -eq 4 ] || { echo "unexpected docker $*" >&2; exit 2; }
fmt="$3"
dir="$FIXTURES/$4"
[ -d "$dir" ] || { echo "Error: No such object: $4" >&2; exit 1; }
array() {
  [ -f "$dir/$1" ] || { printf null; return; }
  local items=() line
  while IFS= read -r line || [ -n "$line" ]; do items+=("$line"); done <"$dir/$1"
  local IFS=,
  printf '[%s]' "${items[*]}"
}
elements() {
  [ -f "$dir/entrypoint" ] && cat "$dir/entrypoint" && [ -s "$dir/entrypoint" ] && echo
  [ -f "$dir/cmd" ] && cat "$dir/cmd" && [ -s "$dir/cmd" ] && echo
  return 0
}
variables() {
  local v
  while IFS= read -r -d '' v; do
    v="${v//\\/\\\\}"
    v="${v//\"/\\\"}"
    v="${v//$'\n'/\\n}"
    v="${v//$'\r'/\\r}"
    v="${v//$'\t'/\\t}"
    printf '"%s"\n' "$v"
  done <"$dir/env"
}
answer() {
  case "$(cat "$dir/mode" 2>/dev/null)" in
    fail-partial) "$1" | head -n 1; exit 1 ;;
    fail-complete) "$1"; exit 1 ;;
    *) "$1" ;;
  esac
}
case "$fmt" in
  '{{.Config.Image}}') cat "$dir/image" ;;
  '{{.State.Running}}') echo false ;;
  '{{range .Config.Env}}{{println .}}{{end}}') tr '\0' '\n' <"$dir/env" ;;
  '{{range .Config.Env}}{{json .}}{{"\n"}}{{end}}') answer variables ;;
  *'{{range .Mounts}}'*) ;;
  *'{{range .Config.Entrypoint}}{{json .}}'*) answer elements ;;
  *'Image: {{.Config.Image}}'*)
    out="${fmt//'{{json .Config.Cmd}}'/"$(array cmd)"}"
    out="${out//'{{json .Config.Entrypoint}}'/"$(array entrypoint)"}"
    printf '%s\n' "$out"
    ;;
  *) echo "unexpected format: $fmt" >&2; exit 2 ;;
esac
EOF
chmod +x "$WORK/bin/docker"

container queue-redis redis:7-alpine '"docker-entrypoint.sh"' \
  "$(printf '"redis-server"\n"--requirepass"\n"%s"\n"--masterauth=%s"\n"-a%s"' "${H[1]}" "${H[2]}" "${H[3]}")"
env_of queue-redis "REDIS_PASSWORD=${H[4]}" TZ=UTC
container custom-n8n example/n8n:1 "$(printf '"/entry.sh"\n"--password"')" "\"${H[5]}\""
container flag-shaped postgres:16 null \
  "$(printf '"postgres"\n"--requirepass"\n"--%s"\n"-c"\n"key=%s"' "${H[6]}" "${H[7]}")"
container shell-string n8nio/n8n:2 '' \
  "$(printf '"sh"\n"-c"\n"line1\\n--x %s \\"q\\" \\\\ \xc3\xa9 redis://u:%s@h"' "${H[8]}" "${H[9]}")"
container empty-name redis:7 null '""'
container spaced-name redis:7 null "$(printf '"my %s"\n"a"' "${H[10]}")"
container dash-name redis:7 null "\"-${H[11]}\""
container no-command redis:7 '' null
container gone-partial redis:7 null "$(printf '"redis-server"\n"%s"' "${H[12]}")" fail-partial
env_of gone-partial "REDIS_HOST=${H[16]}"
container gone-complete redis:7 null "$(printf '"redis-server"\n"%s"' "${H[13]}")" fail-complete
env_of gone-complete "REDIS_HOST=${H[17]}"
container other-app nginx:1 null "$(printf '"nginx"\n"%s"' "${H[15]}")"
container env-values n8nio/n8n:2 null null
env_of env-values \
  "WEBHOOK_URL=https://u:${H[19]}@hooks.example.com/" \
  "QUEUE_BULL_REDIS_URL=redis://:${H[20]}@redis:6379" \
  "DB_POSTGRESDB_URL=postgres://n8n:${H[21]}/x@y@db:5432/n8n" \
  "N8N_URLS=https://a.example.com/,redis://u:${H[22]}@r:6379" \
  "N8N_SPLIT_URL=https:${LF}//u:${H[23]}@hooks.example.com/" \
  "N8N_ONE_SLASH_URL=https:/u:${H[24]}@h/" \
  "N8N_GIT_URL=https://${H[25]}@git.example.com/" \
  "DB_POSTGRESDB_HOST=n8n:${H[26]}@db" \
  "N8N_NOTE=first${LF}redis://u:${H[14]}@h" \
  "N8N_RUNNERS_AUTH_TOKEN=a${LF}N8N_${H[18]}" \
  N8N_EDITOR_BASE_URL=https://n8n.example.com/ \
  N8N_SMTP_SENDER=ops@example.com \
  'N8N_QUOTED=a"b\c'

env PATH="$WORK/bin:$PATH" FIXTURES="$FIXTURES" SHELLOPTS=xtrace BASHOPTS=xpg_echo \
  bash "$REPO/scripts/discover.sh" "$REPORT" >/dev/null 2>&1
check "discover.sh writes a report" test -s "$REPORT"
check "the report has a section per n8n, Postgres and Redis container" \
  test "$(grep -c '^===== Container: ' "$REPORT")" -eq 11

for value in "${H[@]}"; do
  check "the report does not show the value $value" absent "$value"
done

command_is() {
  local got
  got="$(awk -v s="===== Container: $1 =====" '$0 == s { on = 1; next } /^===== / { on = 0 } on && /^Command:/' "$REPORT")"
  [ "$got" = "$2" ] || {
    echo "      $1: expected '$2', got '$got'"
    return 1
  }
}
check "program and argument count" command_is queue-redis "Command: docker-entrypoint.sh (5 arguments, not shown)"
check "entrypoint arguments and command are counted" command_is custom-n8n "Command: /entry.sh (2 arguments, not shown)"
check "a value shaped like an option is counted" command_is flag-shaped "Command: postgres (4 arguments, not shown)"
check "a shell string is one argument" command_is shell-string "Command: sh (2 arguments, not shown)"
check "an empty program name is not shown" command_is empty-name "Command: (name not shown)"
check "a program name with a space is not shown" command_is spaced-name "Command: (name not shown) (1 argument, not shown)"
check "a program name starting with a dash is not shown" command_is dash-name "Command: (name not shown)"
check "no entrypoint and no command" command_is no-command "Command: (none)"
check "a failed, incomplete inspect" command_is gone-partial "Command: (not available)"
check "a failed inspect with a complete answer" command_is gone-complete "Command: (not available)"
check "the environment stays masked" grep -qxF '  REDIS_PASSWORD=*** (set)' "$REPORT"
check "other environment values are shown" grep -qxF '  TZ=UTC' "$REPORT"

env_is() {
  local name="$1" got want
  shift
  got="$(awk -v s="===== Container: $name =====" '$0 == s { on = 1; next } /^===== / { on = 0 }
    on && /^Environment/ { env = 1; next } on && env && /^  / { print; next } { env = 0 }' "$REPORT" | LC_ALL=C sort)"
  want="$(printf '  %s\n' "$@" | LC_ALL=C sort)"
  [ "$got" = "$want" ] || {
    printf '      %s: expected\n%s\n      got\n%s\n' "$name" "$want" "$got"
    return 1
  }
}
check "a failed, incomplete environment inspect" env_is gone-partial "(not available)"
check "a failed environment inspect with a complete answer" env_is gone-complete "(not available)"
check "the user and password of URLs are masked, one line per variable" env_is env-values \
  'DB_POSTGRESDB_HOST=n8n:***@db' \
  'DB_POSTGRESDB_URL=postgres://***@db:5432/n8n' \
  'N8N_EDITOR_BASE_URL=https://n8n.example.com/' \
  'N8N_NOTE=first\nredis://***@h' \
  'N8N_ONE_SLASH_URL=https:/***@h/' \
  'N8N_QUOTED=a\"b\\c' \
  'N8N_RUNNERS_AUTH_TOKEN=*** (set)' \
  'N8N_SMTP_SENDER=ops@example.com' \
  'N8N_SPLIT_URL=https:***@hooks.example.com/' \
  'N8N_GIT_URL=https://***@git.example.com/' \
  'N8N_URLS=https://***@r:6379' \
  'QUEUE_BULL_REDIS_URL=redis://***@redis:6379' \
  'WEBHOOK_URL=https://***@hooks.example.com/'

echo "test-discover: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
