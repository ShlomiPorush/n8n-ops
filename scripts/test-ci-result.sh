#!/usr/bin/env bash
# Tests for scripts/ci-result.sh, with gh replaced by a stand-in that serves canned GitHub API answers
# (one after the other when a test gives several) and fails on request, and sleep by one that only
# counts. Covers which CI run decides, waiting for it, and the final check before a release. Run by
# scripts/verify.sh (guards).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-ci-result-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SHA="1111111111111111111111111111111111111111"
OTHER_SHA="2222222222222222222222222222222222222222"
WORKFLOW_ID=383774817
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
    [ -f "$WORK/case/out" ] && sed 's/^/      | /' "$WORK/case/out" "$WORK/case/err"
  fi
}

# --- stand-ins -------------------------------------------------------------------------------

mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# GitHub API stand-in: answers from $STATE/api/<key>.<n> for the n-th call of that key, else
# $STATE/api/<key>, else 404.
echo "gh $*" >>"$STATE/calls"
[ "$1" = api ] && [ $# -eq 2 ] || { echo "unexpected gh $*" >&2; exit 2; }
[ -n "${MOCK_GH_DOWN:-}" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
case "$2" in
  repos/owner/repo/actions/workflows/ci.yml) key=workflow ;;
  "repos/owner/repo/actions/workflows/$WORKFLOW_ID/runs?head_sha=$SHA&branch=main&"*) key=runs ;;
  repos/owner/repo/actions/runs/*/attempts/*)
    rest="${2#repos/owner/repo/actions/runs/}"
    key="attempt.${rest%%/*}.${rest##*/}"
    ;;
  *) echo "unexpected gh api $2" >&2; exit 2 ;;
esac
n=$(($(cat "$STATE/count.$key" 2>/dev/null || echo 0) + 1))
echo "$n" >"$STATE/count.$key"
for f in "$STATE/api/$key.$n" "$STATE/api/$key"; do
  [ -f "$f" ] && { cat "$f"; exit 0; }
done
echo "gh: Not Found (HTTP 404)" >&2
exit 1
EOF
cat >"$WORK/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >>"$STATE/sleeps"
EOF
chmod +x "$WORK/bin/gh" "$WORK/bin/sleep"
export WORKFLOW_ID SHA

# --- canned answers --------------------------------------------------------------------------

# A fresh case: the CI workflow, no runs yet.
sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/api"
  export STATE="$WORK/case"
  : >"$STATE/calls"
  printf '{"id":%s,"name":"CI","path":".github/workflows/ci.yml","state":"active"}' "$WORKFLOW_ID" >"$STATE/api/workflow"
  runs
}

# A run as the list shows it: run ID ATTEMPT CREATED [EVENT] [BRANCH] [SHA].
run() {
  printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/ci.yml","head_sha":"%s","head_branch":"%s","event":"%s","run_attempt":%s,"status":"completed","conclusion":"success","created_at":"%s"}' \
    "$1" "$WORKFLOW_ID" "${6:-$SHA}" "${5:-main}" "${4:-push}" "$2" "$3"
}

# The runs list (the n-th answer with RUNS_CALL=n): runs RUN_JSON...
runs() {
  local IFS=,
  printf '{"total_count":%s,"workflow_runs":[%s]}' "$#" "$*" >"$STATE/api/runs${RUNS_CALL:+.$RUNS_CALL}"
}

# An attempt (the n-th answer with CALL=n): attempt ID ATTEMPT STATUS [CONCLUSION].
attempt() {
  local conclusion="null"
  [ -n "${4:-}" ] && conclusion="\"$4\""
  printf '{"id":%s,"run_attempt":%s,"workflow_id":%s,"head_sha":"%s","status":"%s","conclusion":%s}' \
    "$1" "$2" "$WORKFLOW_ID" "$SHA" "$3" "$conclusion" >"$STATE/api/attempt.$1.$2${CALL:+.$CALL}"
}

T1="2026-11-01T10:00:00Z"
T2="2026-11-01T11:00:00Z"
T3="2026-11-01T12:00:00Z"

# Runs the script: ci_result MODE_ARGS...; sets RC.
ci_result() {
  (PATH="$WORK/bin:$PATH" GH_REPO=owner/repo CI_RESULT_WAIT_SECONDS="${WAIT:-3}" CI_RESULT_POLL_SECONDS=1 \
    bash "$REPO/scripts/ci-result.sh" --sha "$SHA" "$@") >"$WORK/case/out" 2>"$WORK/case/err"
  RC=$?
}

result() { [ "$(cat "$WORK/case/out")" = "$(printf 'reuse=%s\nrun_id=%s\nreason=%s' "$1" "$2" "$3")" ]; }
reuses() { [ $RC -eq 0 ] && grep -qx "reuse=true" "$WORK/case/out" && grep -qx "run_id=$1" "$WORK/case/out"; }
declines() { [ $RC -eq 0 ] && grep -qx "reuse=false" "$WORK/case/out"; }
said() { grep -q "$1" "$WORK/case/out"; }
waited() {
  local n=0
  [ -f "$STATE/sleeps" ] && n="$(wc -l <"$STATE/sleeps")"
  [ "$n" -eq "$1" ]
}

# --- selection -------------------------------------------------------------------------------

sandbox
ci_result --wait
check "no run: no reuse" declines
check "  and says why" said "reason=no CI run of $SHA on main"
check "  without waiting" waited 0

sandbox
runs "$(run 100 1 "$T1")"
attempt 100 1 completed success
ci_result --wait
check "one green push run: reuse it" reuses 100
check "  with the whole result on stdout" result true 100 "CI run 100 of $SHA (attempt 1) succeeded"
check "  and the request filters by commit and main" grep -q "runs?head_sha=$SHA&branch=main&" "$STATE/calls"

sandbox
runs "$(run 100 1 "$T1" workflow_dispatch)"
attempt 100 1 completed success
ci_result --wait
check "a green manual run on main: reuse it" reuses 100

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
attempt 100 1 completed success
attempt 101 1 completed failure
ci_result --wait
check "green older and newer failed: no reuse" declines
check "  and names the newer run" said "reason=CI run 101 of $SHA (attempt 1) ended with failure"

sandbox
runs "$(run 101 1 "$T2")" "$(run 100 1 "$T1")"
attempt 100 1 completed success
attempt 101 1 completed cancelled
ci_result --wait
check "newer cancelled, listed first: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
attempt 100 1 completed success
CALL=1 attempt 101 1 in_progress
CALL=2 attempt 101 1 queued
CALL=3 attempt 101 1 completed success
ci_result --wait
check "green older and newer in progress then success: reuse the newer" reuses 101
check "  after waiting for it" waited 2

sandbox
runs "$(run 100 1 "$T1")"
CALL=1 attempt 100 1 in_progress
CALL=2 attempt 100 1 completed failure
ci_result --wait
check "in progress then failure: no reuse" declines
check "  with its conclusion" said "ended with failure"

sandbox
runs "$(run 100 1 "$T1")"
attempt 100 1 in_progress
WAIT=3 ci_result --wait
check "in progress beyond the bound: no reuse" declines
check "  and says so" said "reason=CI run 100 of $SHA (attempt 1) is still in_progress after 3s"
check "  after waiting the bound and no longer" waited 3

sandbox
runs "$(run 100 1 "$T1")"
CALL=1 attempt 100 1 in_progress
RUNS_CALL=2 runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
attempt 101 1 completed failure
ci_result --wait
check "a newer run that appears while waiting decides: no reuse" declines
check "  and names it" said "run_id=101"

sandbox
runs "$(run 100 2 "$T1")"
attempt 100 1 completed failure
attempt 100 2 completed success
ci_result --wait
check "success on attempt 2: reuse it" reuses 100
check "  and says which attempt" said "(attempt 2) succeeded"

sandbox
runs "$(run 100 2 "$T1")"
attempt 100 1 completed success
attempt 100 2 completed failure
ci_result --wait
check "latest attempt failed after an earlier success: no reuse" declines

sandbox
runs "$(run 100 1 "$T1" pull_request)"
attempt 100 1 completed success
ci_result --wait
check "a green pull request run of the same commit: ignored" declines
check "  as if there were none" said "reason=no CI run"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2" pull_request)"
attempt 100 1 completed success
attempt 101 1 completed failure
ci_result --wait
check "a newer pull request run beside a green push run: the push run decides" reuses 100

sandbox
runs "$(run 100 1 "$T1" push feature)"
attempt 100 1 completed success
ci_result --wait
check "a green run on another branch: ignored" declines

sandbox
runs "$(run 100 1 "$T1" schedule)"
attempt 100 1 completed success
ci_result --wait
check "a green scheduled run: ignored" declines

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2" push main "$OTHER_SHA")"
attempt 100 1 completed success
ci_result --wait
check "a run of another commit in the answer: ignored" reuses 100

sandbox
printf '{"id":%s,"workflow_id":999,"path":".github/workflows/ci.yml","head_sha":"%s","head_branch":"main","event":"push","run_attempt":1,"created_at":"%s"}' \
  101 "$SHA" "$T2" >"$WORK/case/other"
runs "$(run 100 1 "$T1")" "$(cat "$WORK/case/other")"
attempt 100 1 completed success
ci_result --wait
check "a run of another workflow in the answer: ignored" reuses 100

sandbox
printf '{"id":%s,"name":"CI","path":".github/workflows/other.yml"}' "$WORKFLOW_ID" >"$STATE/api/workflow"
ci_result --wait
check "the workflow file is not ci.yml: no reuse" declines

# --- failures --------------------------------------------------------------------------------

sandbox
runs "$(run 100 1 "$T1")"
attempt 100 1 completed success
MOCK_GH_DOWN=1 ci_result --wait
check "API error: no reuse, and the script itself succeeds" declines
check "  and says why" said "reason=cannot read the CI workflow"

sandbox
runs "$(run 100 1 "$T1")"
ci_result --wait
check "the attempt cannot be read: no reuse" declines
check "  and says why" said "reason=cannot read attempt 1 of CI run 100"

sandbox
printf '{"total_count":1,"workflow_runs":[{"id":100,' >"$STATE/api/runs"
ci_result --wait
check "malformed JSON: no reuse" declines
check "  and says why" said "reason=cannot read the CI runs"

sandbox
printf '{"total_count":1,"workflow_runs":[{"id":"100","workflow_id":%s}]}' "$WORKFLOW_ID" >"$STATE/api/runs"
ci_result --wait
check "a run without the expected fields: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
sed -i 's/"total_count":1/"total_count":101/' "$STATE/api/runs"
ci_result --wait
check "more runs than one page: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
printf '{"id":100,"run_attempt":1,"head_sha":"%s","status":"completed","conclusion":"success"}' "$OTHER_SHA" >"$STATE/api/attempt.100.1"
ci_result --wait
check "an attempt of another commit: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
attempt 100 1 stale
ci_result --wait
check "an unknown status: no reuse" declines

# --- final check -----------------------------------------------------------------------------

sandbox
runs "$(run 100 1 "$T1")"
attempt 100 1 completed success
ci_result --expect-run 100
check "final check, the run unchanged: go on" [ $RC -eq 0 ]
check "  and says so" said "reuse=true"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
attempt 100 1 completed success
attempt 101 1 completed success
ci_result --expect-run 100
check "final check, a newer run appeared: stop" [ $RC -eq 1 ]
check "  and says why" said "reason=CI run 101 of $SHA (attempt 1) is newer than the reused run 100"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T3")"
attempt 100 1 completed success
attempt 101 1 in_progress
ci_result --expect-run 100
check "final check, a newer run still running: stop without waiting" [ $RC -eq 1 ]
check "  without waiting" waited 0

sandbox
runs "$(run 100 2 "$T1")"
attempt 100 1 completed success
attempt 100 2 in_progress
ci_result --expect-run 100
check "final check, the run started again: stop" [ $RC -eq 1 ]

sandbox
ci_result --expect-run 100
check "final check, no run any more: stop" [ $RC -eq 1 ]

sandbox
MOCK_GH_DOWN=1 ci_result --expect-run 100
check "final check, API error: stop" [ $RC -eq 1 ]

# --- usage -----------------------------------------------------------------------------------

sandbox
ci_result
check "no mode: usage error" [ $RC -eq 2 ]
(PATH="$WORK/bin:$PATH" GH_REPO=owner/repo bash "$REPO/scripts/ci-result.sh" --sha abc --wait) >/dev/null 2>&1
check "a short SHA: usage error" [ $? -eq 2 ]
(PATH="$WORK/bin:$PATH" GH_REPO="" bash "$REPO/scripts/ci-result.sh" --sha "$SHA" --wait) >/dev/null 2>&1
check "no GH_REPO: usage error" [ $? -eq 2 ]

echo "ci-result.sh: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
