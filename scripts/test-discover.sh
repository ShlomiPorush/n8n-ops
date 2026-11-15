#!/usr/bin/env bash
# Tests for scripts/discover.sh, with docker replaced by a stand-in that serves canned containers.
# Covers the Command line of each container (its program and the number of its arguments, never an
# argument), an inspect answer that fails or is incomplete, and the masked environment. Values the
# report must not show are made new for each run. Run by scripts/verify.sh (guards).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-discover-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FIXTURES="$WORK/containers"
REPORT="$WORK/report.txt"
FAILED=0
PASSED=0
# Values the report must not show, new for each run: H[1] to H[15].
H=()
for i in $(seq 15); do
  H[i]="v$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
done

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

# container NAME IMAGE ENTRYPOINT CMD [MODE]: ENTRYPOINT and CMD hold one JSON-encoded element per
# line, as docker renders {{json .}}, or "null" for a list that is not set. MODE makes the inspect
# of the command fail-partial (exit 1, cut short), no-end (exit 0, cut short) or fail-complete.
container() {
  local dir="$FIXTURES/$1"
  mkdir -p "$dir"
  printf '%s\n' "$2" >"$dir/image"
  [ "$3" = null ] || printf '%s' "$3" >"$dir/entrypoint"
  [ "$4" = null ] || printf '%s' "$4" >"$dir/cmd"
  [ -z "${5:-}" ] || printf '%s\n' "$5" >"$dir/mode"
  : >"$dir/env"
}

# --- stand-in -------------------------------------------------------------------------------

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# docker stand-in: containers are the directories under $FIXTURES.
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
# The list as a JSON array, as {{json .Config.X}} renders it.
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
case "$fmt" in
  '{{.Config.Image}}') cat "$dir/image" ;;
  '{{.State.Running}}') echo false ;;
  *'{{range .Config.Env}}'*) cat "$dir/env" ;;
  *'{{range .Mounts}}'*) ;;
  *'{{range .Config.Entrypoint}}{{json .}}'*)
    case "$(cat "$dir/mode" 2>/dev/null)" in
      fail-partial) elements | head -c 20; exit 1 ;;
      no-end) elements ;;
      fail-complete) elements; printf end; exit 1 ;;
      *) elements; printf end ;;
    esac
    ;;
  *'Image: {{.Config.Image}}'*)
    out="${fmt//'{{json .Config.Cmd}}'/"$(array cmd)"}"
    out="${out//'{{json .Config.Entrypoint}}'/"$(array entrypoint)"}"
    printf '%s\n' "$out"
    ;;
  *) echo "unexpected format: $fmt" >&2; exit 2 ;;
esac
EOF
chmod +x "$WORK/bin/docker"

# --- containers ------------------------------------------------------------------------------

container queue-redis redis:7-alpine '"docker-entrypoint.sh"' \
  "$(printf '"redis-server"\n"--requirepass"\n"%s"\n"--masterauth=%s"\n"-a%s"' "${H[1]}" "${H[2]}" "${H[3]}")"
printf 'REDIS_PASSWORD=%s\nTZ=UTC\n' "${H[4]}" >"$FIXTURES/queue-redis/env"
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
container gone-no-end redis:7 null "$(printf '"redis-server"\n"%s"' "${H[13]}")" no-end
container gone-complete redis:7 null "$(printf '"redis-server"\n"%s"' "${H[14]}")" fail-complete
container other-app nginx:1 null "$(printf '"nginx"\n"%s"' "${H[15]}")"

# --- run ---------------------------------------------------------------------------------------

PATH="$WORK/bin:$PATH" FIXTURES="$FIXTURES" bash "$REPO/scripts/discover.sh" "$REPORT" >/dev/null 2>&1
check "discover.sh writes a report" test -s "$REPORT"
check "the report has a section per n8n, Postgres and Redis container" \
  test "$(grep -c '^===== Container: ' "$REPORT")" -eq 11

for value in "${H[@]}"; do
  check "the report does not show the value $value" absent "$value"
done

# command_is NAME LINE: the Command line in the section of container NAME.
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
check "an inspect without its end" command_is gone-no-end "Command: (not available)"
check "a failed inspect with a complete answer" command_is gone-complete "Command: (not available)"
check "the environment stays masked" grep -qxF '  REDIS_PASSWORD=*** (set)' "$REPORT"
check "other environment values are shown" grep -qxF '  TZ=UTC' "$REPORT"

echo "test-discover: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
