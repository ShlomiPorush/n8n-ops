#!/bin/sh
# n8n-ops for agents on Linux and macOS without Node: plain POSIX sh and curl, nothing else.
#
# One of three versions with one contract (see n8n-ops.mjs): same commands, same JSON output and error codes, same
# files and the same lock, so they can run side by side. Tokens never appear in the output, and never on a command
# line (other users can read those): curl reads them from its standard input.
# R_* fields are read and written through eval (record_read, record_write).
# shellcheck disable=SC2034
set -u
set -f
umask 077

# Filled in with the n8n-ops address when the file is downloaded from n8n-ops.
DEFAULT_URL="__N8N_OPS_URL__"
CLIENT_ID="n8n-ops-cli"
SCOPE="ops:read ops:access offline_access"
WAIT_SECONDS="${N8N_OPS_WAIT_SECONDS:-90}"
POLL_SECONDS="${N8N_OPS_TEST_POLL_SECONDS:-5}"
# A refresh is retried only once it cannot be in flight any more: twice the request timeout (tests shorten it).
REFRESH_GRACE="${N8N_OPS_TEST_REFRESH_GRACE:-30}"
LOCK_WAIT_MS="${N8N_OPS_LOCK_WAIT_MS:-20000}"
FIELDS="v:n issuer:s label:s generation:s refreshToken:s accessToken:s accessExpiresAt:n scope:s refreshStartedAt:n refreshRetried:n deviceCode:s userCode:s link:s deviceExpiresAt:n interval:n nextPollAt:n toRevoke:s"

LOCKTOKEN=""
TMPD=""
SECURED=0

now() { date +%s; }
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
host() { uname -n; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
nap() { sleep "$1" 2>/dev/null || sleep 1; }
# A message or path inside a JSON string.
esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cleanup() {
  [ -n "$LOCKTOKEN" ] && release
  [ -n "$TMPD" ] && rm -rf -- "$TMPD"
  return 0
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# fail CODE MESSAGE [BODYFILE]: prints the error and stops; a body is included when it is JSON.
fail() {
  body=""
  if [ $# -ge 3 ] && [ -s "$3" ]; then
    first=$(tr -d ' \t\r\n' <"$3" | cut -c1)
    case "$first" in "{" | "[") body=",\"body\":$(cat "$3")" ;; esac
  fi
  printf '{"error":"%s","message":"%s"%s}\n' "$1" "$(esc "$2")" "$body"
  exit 1
}

# Reading flat JSON: one string or number field; values with escapes do not match and read as empty.
jstr() { tr -d '\r\n' <"$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p'; }
jnum() {
  v=$(tr -d '\r\n' <"$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  printf '%s' "${v:-0}"
}
secret_ok() { case "$1" in "" | *[!A-Za-z0-9._~+/=-]*) return 1 ;; esac }
plain_ok() { case "$1" in *[\"\\]*) return 1 ;; esac }

HELP="n8n-ops: use n8n-ops after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to $WAIT_SECONDS s for the approval; run again while it answers still_waiting.
  get <path>            GET /api/v1<path>, for example: get 'problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this agent is connected (no secrets).
  disconnect            End this agent's connection.

  --url <address>       The n8n-ops address (or N8N_OPS_URL)."

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else openssl dgst -sha256 -r; fi
}

# The n8n-ops address, this agent's identity (the folder it is installed in) and where its connection is kept.
setup() {
  command -v curl >/dev/null 2>&1 || fail missing_curl "curl is needed. Install curl, or Node 20 or later."
  raw="${URL_OPTION:-${N8N_OPS_URL:-}}"
  if [ -z "$raw" ]; then case "$DEFAULT_URL" in __*) ;; *) raw="$DEFAULT_URL" ;; esac fi
  [ -n "$raw" ] || fail no_url "No n8n-ops address. Pass --url https://<your n8n-ops> or set N8N_OPS_URL."
  raw=${raw%/}
  case "$raw" in
    https://*) rest=${raw#https://} PROTO=https ;;
    http://*) rest=${raw#http://} PROTO=http ;;
    *) fail insecure_url "The n8n-ops address must start with https:// (http only for this computer)." ;;
  esac
  hostpart=$(lower "$rest")
  case "$hostpart" in
    "[::1]" | "[::1]:"*) name="[::1]" port=${hostpart#"[::1]"} ;;
    "" | *[!a-z0-9.:-]* | :* | *:*:*) fail insecure_url "Use the n8n-ops address alone, for example https://ops.example.com." ;;
    *) name=${hostpart%%:*} port=${hostpart#"$name"} ;;
  esac
  case "$port" in "" | :[0-9]*) ;; *) fail insecure_url "Use the n8n-ops address alone, for example https://ops.example.com." ;; esac
  if [ "$PROTO" = http ]; then
    case "$name" in 127.0.0.1 | localhost | "[::1]") ;; *) fail insecure_url "The n8n-ops address must start with https:// (http only for this computer)." ;; esac
  fi
  # As a browser writes the origin: lower case, no default port.
  case "$hostpart" in *:443) [ "$PROTO" = https ] && hostpart=${hostpart%:443} ;; *:80) [ "$PROTO" = http ] && hostpart=${hostpart%:80} ;; esac
  ISSUER="$PROTO://$hostpart"
  INSTALL=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || fail failed "Cannot find the skill's folder."
  base="${XDG_CONFIG_HOME:-$HOME/.config}"
  DIR="${N8N_OPS_CREDENTIALS:-$base/n8n-ops}"
  case "$DIR" in /*) ;; *) DIR="$(pwd -P)/$DIR" ;; esac
  plain_ok "$DIR" || fail insecure_credentials "The n8n-ops folder's path cannot contain quotes or backslashes."
  install_id
  key=$(printf '%s\n%s' "$ISSUER" "$ID" | sha | cut -c1-32)
  FILE="$DIR/$key.json"
  LOCK="$DIR/$key.lock"
  if [ -n "${N8N_OPS_AGENT_NAME:-}" ]; then
    LABEL=$(printf '%s' "$N8N_OPS_AGENT_NAME" | cut -c1-60)
  else
    agent="Agent"
    oldifs=$IFS
    IFS=/
    for part in $INSTALL; do
      p=$(lower "$part")
      case "$p" in
        .claude) agent="Claude Code" && break ;;
        .claude*) agent="Claude Code ($p)" && break ;;
        .codex) agent="Codex" && break ;;
        .codex*) agent="Codex ($p)" && break ;;
        .cursor*) agent="Cursor" && break ;;
      esac
    done
    IFS=$oldifs
    LABEL=$(printf '%s on %s' "$agent" "$(host)" | cut -c1-60)
  fi
}

# This install's id, kept in the skill's folder (.install-id), so every version agrees on it however each one spells
# the folder's path. Published in one step: written aside, then linked into place, which fails if one is there.
install_id() {
  f="$INSTALL/.install-id"
  id=$(head -n1 "$f" 2>/dev/null | tr -d '\r')
  case "$id" in "" | *[!0-9a-f]*) id="" ;; esac
  if [ ${#id} -ne 32 ]; then
    t="$f.$(rand 6)"
    if (
      set -C
      printf '%s\n' "$(rand 16)" >"$t"
    ) 2>/dev/null; then ln "$t" "$f" 2>/dev/null || :; fi
    rm -f "$t"
    id=$(head -n1 "$f" 2>/dev/null | tr -d '\r')
    case "$id" in "" | *[!0-9a-f]*) id="" ;; esac
  fi
  [ ${#id} -eq 32 ] || fail cannot_save "Cannot write in $INSTALL. The agent's id is kept there; allow writing it."
  ID=$id
}

# Only this user may open the folder and its files; never loosened or fixed silently.
check_private() {
  [ -L "$1" ] && fail insecure_credentials "$1 must be plain, not a link."
  [ -O "$1" ] || fail insecure_credentials "$1 belongs to another user. Use a folder of your own."
  # The mode string itself is what is checked; the path is ours.
  # shellcheck disable=SC2012
  mode=$(ls -ld "$1" | cut -c5-11)
  case "$mode" in
    ------ | "------ " | ------@ | ------.) ;;
    *) if [ -d "$1" ]; then fail insecure_credentials "Others can open $1. Run: chmod 700 '$1'"; else fail insecure_credentials "Others can read $1. Run: chmod 600 '$1'"; fi ;;
  esac
}

secure_dir() {
  [ "$SECURED" = 1 ] && return 0
  mkdir -p "$DIR" 2>/dev/null || fail cannot_save "Cannot create $DIR. Allow this agent to write there."
  [ -d "$DIR" ] || fail insecure_credentials "$DIR must be a plain folder."
  check_private "$DIR"
  SECURED=1
  # Temp files of commands that were killed (their own cleanup never ran).
  set +f
  for d in "$DIR"/.tmp.*; do
    [ -d "$d" ] || continue
    pid=${d##*/.tmp.}
    pid=${pid%%.*}
    alive "$pid" || rm -rf -- "$d"
  done
  set -f
}

# A private folder for this command's temp files, inside the credentials folder (so a rename stays atomic).
tmpdir() {
  [ -n "$TMPD" ] && return 0
  secure_dir
  TMPD="$DIR/.tmp.$$.$(rand 4)"
  mkdir "$TMPD" 2>/dev/null || fail cannot_save "Cannot write in $DIR. Allow this agent to write there."
}

# The connection: one shell variable per field, R_<name>.
record_clear() {
  for f in $FIELDS; do
    k=${f%%:*}
    case "$f" in *:n) eval "R_$k=0" ;; *) eval "R_$k=''" ;; esac
  done
  R_v=1 R_issuer="$ISSUER" R_label="$LABEL"
}

# record_read: 0 when there is a record, 1 when there is none.
record_read() {
  record_clear
  [ -e "$FILE" ] || return 1
  [ -f "$FILE" ] || fail insecure_credentials "$FILE must be a plain file."
  check_private "$FILE"
  grep -q '^{' "$FILE" || fail insecure_credentials "$FILE is damaged. Delete it and connect again."
  for f in $FIELDS; do
    k=${f%%:*}
    case "$f" in
      *:n) v=$(jnum "$k" "$FILE") ;;
      *) v=$(jstr "$k" "$FILE") ;;
    esac
    eval "R_$k=\$v"
  done
  return 0
}

record_write() {
  secure_dir
  out="{"
  sep=""
  for f in $FIELDS; do
    k=${f%%:*}
    eval "v=\${R_$k}"
    case "$f" in
      *:n)
        case "$v" in "" | *[!0-9]*) v=0 ;; esac
        out="$out$sep\"$k\":$v"
        ;;
      *)
        plain_ok "$v" || fail unexpected_answer "n8n-ops sent a value that cannot be stored ($k)."
        out="$out$sep\"$k\":\"$v\""
        ;;
    esac
    sep=","
  done
  tmpdir
  tmp="$TMPD/record.$(rand 6)"
  # noclobber: created new, private by the umask.
  if ! (
    set -C
    printf '%s}\n' "$out" >"$tmp"
  ) 2>/dev/null; then
    fail cannot_save "Cannot write in $DIR. Allow this agent to write there."
  fi
  sync -- "$tmp" 2>/dev/null || :
  mv -f "$tmp" "$FILE" 2>/dev/null || fail cannot_save "Cannot replace $FILE."
}

record_remove() { rm -f "$FILE"; }

# The lock: a file created exclusively, naming its holder. Never taken from a live holder, however old.

lock_field() { printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p'; }

hook() {
  name=$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')
  eval "at=\${N8N_OPS_TEST_HOLD_$name:-}"
  [ -n "$at" ] || return 0
  printf '%s' "$$" >"$at.reached"
  i=0
  while [ $i -lt 1200 ] && [ ! -e "$at.go" ]; do
    nap 0.05
    i=$((i + 1))
  done
}

alive() { kill -0 "$1" 2>/dev/null; }

# acquire [OWN]: takes the lock; OWN is a lock this process held before, which counts as taken if it is back in place.
acquire() {
  own=${1:-}
  secure_dir
  token=$(rand 16)
  line=$(printf '{"pid":%s,"host":"%s","token":"%s","startedAt":%s}' "$$" "$(host)" "$token" "$(now)")
  waited=0
  while :; do
    if (
      set -C
      printf '%s' "$line" >"$LOCK"
    ) 2>/dev/null; then
      LOCKTOKEN=$token
      hook locked
      return 0
    fi
    [ -e "$LOCK" ] || [ -w "$DIR" ] || fail cannot_save "Cannot create a lock in $DIR."
    held=$(cat "$LOCK" 2>/dev/null) || held=""
    dead=0
    if [ -e "$LOCK" ]; then
      htoken=$(lock_field "$held" token)
      # Another process moved this one's lock away by mistake and has put it back.
      if [ -n "$own" ] && [ "$htoken" = "$own" ]; then
        LOCKTOKEN=$own
        return 0
      fi
      if [ -z "$htoken" ]; then
        # A holder that died between creating the lock and writing its name leaves it empty; that takes a moment.
        [ -n "$(find "$LOCK" -mmin +1 2>/dev/null)" ] && dead=1
      elif [ "$(lower "$(lock_field "$held" host)")" = "$(lower "$(host)")" ] && ! alive "$(lock_field "$held" pid)"; then
        dead=1
      fi
    fi
    if [ $dead = 1 ]; then
      hook break-observed
      if break_lock "$htoken"; then continue; fi
    fi
    if [ "$waited" -gt "$LOCK_WAIT_MS" ]; then
      started=$(lock_field "$held" startedAt)
      if [ -n "$htoken" ] && [ -n "$started" ] && [ $(($(now) - started)) -gt 600 ]; then
        fail busy "Another n8n-ops command has held $LOCK for over 10 minutes. If none is running, delete that file."
      fi
      fail busy "Another n8n-ops command is using this connection. Nothing was sent; run it again."
    fi
    nap 0.2
    waited=$((waited + 200))
  done
}

# Moving the dead lock away is atomic, so of two that try only one moves it; if what was moved is not the dead lock
# (another process had just taken a fresh one), it goes back unless a newer one is there (ln never overwrites).
break_lock() {
  moved="$LOCK.$(rand 6).dead"
  mv "$LOCK" "$moved" 2>/dev/null || return 0
  hook break-moved
  got=$(lock_field "$(cat "$moved" 2>/dev/null)" token)
  if [ "$got" = "$1" ]; then
    rm -f "$moved"
    return 0
  fi
  ln "$moved" "$LOCK" 2>/dev/null || :
  rm -f "$moved"
  return 1
}

mine() { [ -n "$LOCKTOKEN" ] && [ "$(lock_field "$(cat "$LOCK" 2>/dev/null)" token)" = "$LOCKTOKEN" ]; }

release() {
  mine && rm -f "$LOCK"
  LOCKTOKEN=""
}

assert_mine() { mine || fail busy "Another n8n-ops command took over this connection. Run it again."; }

# Requests. http METHOD URL [SETTINGS]: SETTINGS are more curl settings, with the secrets; curl reads them from its
# standard input (printf is built in, so they are on no command line). Sets STATUS, RESP and SENT (no when the name,
# the connection or TLS failed first, so nothing reached n8n-ops).
http() {
  tmpdir
  RESP="$TMPD/resp.$(rand 6)"
  errf="$TMPD/err.$(rand 6)"
  STATUS=$(printf 'url = "%s"\nrequest = "%s"\nheader = "Accept: application/json"\n%s\n' "$2" "$1" "${3:-}" |
    curl -q -sS -K - --proto "=$PROTO" --max-time 15 --connect-timeout 10 -o "$RESP" -w '%{http_code}' 2>"$errf")
  rc=$?
  SENT=yes
  if [ $rc -ne 0 ]; then
    case $rc in 5 | 6 | 7 | 35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 83 | 90 | 91) SENT=no ;; esac
    UNREACHABLE="Cannot reach $ISSUER ($(tr -d '\r\n' <"$errf" | cut -c1-120))."
    return 1
  fi
  return 0
}

# oauth PATH NAME=VALUE...: a form post to the authorization server.
oauth() {
  p=$1
  shift
  settings=$(printf 'data-urlencode = "client_id=%s"' "$CLIENT_ID")
  for kv in "$@"; do settings=$(printf '%s\ndata-urlencode = "%s"' "$settings" "$kv"); done
  http POST "$ISSUER$p" "$settings"
}

http_fail() {
  detail=$(jstr error_description "$RESP")
  [ -n "$detail" ] || detail=$(jstr message "$RESP")
  [ -n "$detail" ] || detail=$(jstr error "$RESP")
  if [ -n "$detail" ]; then fail "http_$STATUS" "$1 failed ($STATUS: $detail)." "$RESP"; fi
  fail "http_$STATUS" "$1 failed ($STATUS)." "$RESP"
}

# Reads the tokens of a 200 answer into the record variables.
take_tokens() {
  at=$(jstr access_token "$RESP")
  rt=$(jstr refresh_token "$RESP")
  sc=$(jstr scope "$RESP")
  ex=$(jnum expires_in "$RESP")
  if ! secret_ok "$at" || ! secret_ok "$rt" || ! plain_ok "$sc"; then
    fail unexpected_answer "n8n-ops answered without usable tokens."
  fi
  R_refreshToken=$rt R_accessToken=$at R_scope=$sc R_accessExpiresAt=$(($(now) + ex))
}

revoke_pending() {
  [ -n "$R_toRevoke" ] || return 0
  left=""
  for t in $R_toRevoke; do
    if oauth /oauth/revoke "token=$t" "token_type_hint=refresh_token" && [ "$STATUS" = 200 ]; then :; else left="$left $t"; fi
  done
  left=$(printf '%s' "$left" | sed 's/^ *//')
  if [ "$left" != "$R_toRevoke" ]; then
    R_toRevoke=$left
    record_write
  fi
}

clear_pending() { R_deviceCode='' R_userCode='' R_link='' R_deviceExpiresAt=0 R_interval=0 R_nextPollAt=0; }

print_pending() {
  left=$((R_deviceExpiresAt - $(now)))
  [ $left -lt 0 ] && left=0
  printf '{"status":"pending","link":"%s","code":"%s","expiresIn":%s,"next":"Show the person the link and the code, then run: n8n-ops connect --wait"}\n' \
    "$(esc "$R_link")" "$(esc "$R_userCode")" "$left"
}

# Commands

cmd_status() {
  if record_read && [ -n "$R_refreshToken" ]; then
    left=$((R_accessExpiresAt - $(now)))
    [ $left -lt 0 ] && left=0
    printf '{"status":"connected","url":"%s","label":"%s","scope":"%s","accessExpiresIn":%s}\n' \
      "$ISSUER" "$(esc "$R_label")" "$(esc "$R_scope")" "$left"
  elif [ -n "$R_deviceCode" ]; then
    printf '{"status":"pending","url":"%s","label":"%s"}\n' "$ISSUER" "$(esc "$R_label")"
  else
    printf '{"status":"not_connected","url":"%s","label":"%s"}\n' "$ISSUER" "$(esc "$LABEL")"
  fi
}

cmd_connect() {
  # Before any code exists: can it keep a connection here, and is n8n-ops there?
  secure_dir
  probe="$DIR/.probe-$(rand 4)"
  if ! (
    set -C
    : >"$probe"
  ) 2>/dev/null; then fail cannot_save "Cannot write in $DIR. Allow this agent to write there."; fi
  rm -f "$probe"
  http GET "$ISSUER/.well-known/oauth-authorization-server" || fail unreachable "$UNREACHABLE"
  if [ "$STATUS" != 200 ] || [ "$(jstr issuer "$RESP")" != "$ISSUER" ]; then
    fail unreachable "$ISSUER does not answer as n8n-ops ($STATUS). Check the address."
  fi
  acquire
  record_read || :
  revoke_pending
  if [ -n "$R_refreshToken" ] && [ "$REPLACE" != 1 ]; then
    printf '{"status":"already_connected","label":"%s","scope":"%s"}\n' "$(esc "$R_label")" "$(esc "$R_scope")"
    return 0
  fi
  # The open code again, unless asked for a new one (--replace: the link did not work for the person).
  if [ -n "$R_deviceCode" ] && [ $((R_deviceExpiresAt - $(now))) -gt 30 ] && [ "$REPLACE" != 1 ]; then
    print_pending
    return 0
  fi
  assert_mine
  oauth /oauth/device "scope=$SCOPE" "resource=$ISSUER/api/v1" "client_label=$LABEL" || fail unreachable "$UNREACHABLE"
  [ "$STATUS" = 200 ] || http_fail "Asking to connect"
  dc=$(jstr device_code "$RESP")
  uc=$(jstr user_code "$RESP")
  link=$(jstr verification_uri_complete "$RESP")
  secret_ok "$dc" || fail unexpected_answer "n8n-ops answered without a code."
  case "$uc" in "" | *[!A-Z0-9-]*) fail unexpected_answer "n8n-ops answered without a code." ;; esac
  case "$link" in "$ISSUER"/*) ;; *) fail unexpected_answer "The approval link is not on n8n-ops." ;; esac
  plain_ok "$link" || fail unexpected_answer "n8n-ops answered without a code."
  interval=$(jnum interval "$RESP")
  [ "$interval" -le 0 ] && interval=$POLL_SECONDS
  [ "$interval" -lt "$POLL_SECONDS" ] && interval=$POLL_SECONDS
  expires=$(jnum expires_in "$RESP")
  [ "$expires" -le 0 ] && expires=600
  [ "$expires" -lt 60 ] && expires=60
  R_label=$LABEL R_deviceCode=$dc R_userCode=$uc R_link=$link
  R_deviceExpiresAt=$(($(now) + expires)) R_interval=$interval R_nextPollAt=$(($(now) + interval))
  record_write
  print_pending
}

cmd_wait() {
  until=$(($(now) + WAIT_SECONDS))
  while :; do
    acquire
    if ! record_read || [ -z "$R_deviceCode" ]; then
      if [ -n "$R_refreshToken" ]; then
        printf '{"status":"connected","label":"%s","scope":"%s"}\n' "$(esc "$R_label")" "$(esc "$R_scope")"
        return 0
      fi
      fail not_connected "No connection is being made. Run: n8n-ops connect"
    fi
    t=$(now)
    if [ "$R_deviceExpiresAt" -le "$t" ]; then
      clear_pending
      record_write
      fail expired "The code expired before it was approved. Run: n8n-ops connect"
    fi
    wait=0
    if [ "$R_nextPollAt" -gt "$t" ]; then
      wait=$((R_nextPollAt - t))
    else
      assert_mine
      if ! oauth /oauth/token "grant_type=urn:ietf:params:oauth:grant-type:device_code" "device_code=$R_deviceCode"; then
        R_nextPollAt=$((t + R_interval))
        record_write
        fail unreachable "$UNREACHABLE"
      fi
      err=$(jstr error "$RESP")
      if [ "$STATUS" = 200 ]; then
        old=$R_refreshToken
        take_tokens
        # Connecting again (--replace): the old connection is ended once the new one is stored.
        if [ -n "$old" ] && [ "$old" != "$R_refreshToken" ]; then R_toRevoke=$(printf '%s %s' "$R_toRevoke" "$old" | sed 's/^ *//'); fi
        clear_pending
        R_generation=$(rand 8) R_refreshStartedAt=0 R_refreshRetried=0
        record_write
        revoke_pending
        printf '{"status":"connected","label":"%s","scope":"%s"}\n' "$(esc "$R_label")" "$(esc "$R_scope")"
        return 0
      fi
      case "$err" in
        authorization_pending | slow_down)
          [ "$err" = slow_down ] && R_interval=$((R_interval + 5))
          R_nextPollAt=$((t + R_interval))
          record_write
          wait=$R_interval
          ;;
        access_denied)
          clear_pending
          record_write
          fail denied "The person did not approve the connection."
          ;;
        expired_token | invalid_grant)
          clear_pending
          record_write
          fail expired "The code is no longer valid. Run: n8n-ops connect"
          ;;
        *) http_fail "Waiting for the approval" ;;
      esac
    fi
    release
    if [ $(($(now) + wait)) -gt "$until" ]; then
      printf '{"status":"still_waiting","next":"Not approved yet. Run again: n8n-ops connect --wait"}\n'
      return 0
    fi
    sleep "$wait"
  done
}

usable() { [ -n "$R_accessToken" ] && [ $((R_accessExpiresAt - $(now))) -gt 60 ] && [ "$R_refreshStartedAt" = 0 ]; }

# access_token [STALE]: sets TOKEN to a live access token: the stored one while it lasts, else one refresh.
access_token() {
  stale=${1:-}
  record_read || fail not_connected "Not connected. Run: n8n-ops connect"
  [ -n "$R_refreshToken" ] || fail not_connected "Not connected. Run: n8n-ops connect"
  if [ -z "$stale" ] && usable; then
    TOKEN=$R_accessToken
    return 0
  fi
  acquire
  record_read || fail not_connected "Not connected. Run: n8n-ops connect"
  [ -n "$R_refreshToken" ] || fail not_connected "Not connected. Run: n8n-ops connect"
  revoke_pending
  # Another command refreshed while this one waited for the lock.
  if usable && [ "$R_accessToken" != "$stale" ]; then
    TOKEN=$R_accessToken
    release
    return 0
  fi
  b_started=$R_refreshStartedAt
  b_retried=$R_refreshRetried
  # A refresh that started moments ago may still be on its way (its holder lost the lock): never send it twice.
  if [ "$R_refreshStartedAt" != 0 ] && [ $(($(now) - R_refreshStartedAt)) -lt "$REFRESH_GRACE" ]; then
    fail busy "Another n8n-ops command is refreshing this connection. Nothing was sent; run it again."
  fi
  if [ "$R_refreshStartedAt" != 0 ]; then
    # The last refresh got no answer; trying once more either continues the connection or ends it there.
    [ "$R_refreshRetried" != 0 ] && fail connection_ended "Two refreshes got no answer, so this connection cannot be trusted. Run: n8n-ops connect --replace"
    R_refreshRetried=1
  fi
  R_refreshStartedAt=$(now)
  record_write
  assert_mine
  hook before-refresh
  if ! oauth /oauth/token "grant_type=refresh_token" "refresh_token=$R_refreshToken"; then
    # Nothing left the computer: the token is as good as before.
    if [ "$SENT" = no ]; then
      R_refreshStartedAt=$b_started R_refreshRetried=$b_retried
      record_write
    fi
    fail unreachable "$UNREACHABLE"
  fi
  if [ "$STATUS" = 200 ]; then
    take_tokens
    R_refreshStartedAt=0 R_refreshRetried=0
    hook before-write
    if ! mine; then
      # The lock was taken while this one waited for n8n-ops: keep the new tokens anyway, under a fresh lock.
      held_before=$LOCKTOKEN
      LOCKTOKEN=""
      acquire "$held_before"
    fi
    record_write
    TOKEN=$R_accessToken
    release
    return 0
  fi
  if [ "$(jstr error "$RESP")" = invalid_grant ]; then
    # An old connection still to be ended (after --replace) keeps its place until n8n-ops confirms it.
    if [ -n "$R_toRevoke" ]; then
      keep=$R_toRevoke
      name=$R_label
      record_clear
      R_toRevoke=$keep R_label=$name
      record_write
    else
      record_remove
    fi
    fail connection_ended "This connection has ended (disconnected in n8n-ops, unused for 90 days, or its token was used twice). Run: n8n-ops connect"
  fi
  # n8n-ops answered with an error before spending the token (a 4xx); a 5xx may have come after.
  if [ "$STATUS" -lt 500 ]; then
    R_refreshStartedAt=$b_started R_refreshRetried=$b_retried
    record_write
  fi
  http_fail "Refreshing the connection"
}

api_url() {
  bad="Give a path of the API, for example: problems?status=open (percent-encode anything else)"
  case "$1" in "" | *://* | //* | *[!A-Za-z0-9._~!\$\&\'\(\)*+,\;=:@/?%-]*) fail bad_path "$bad" ;; esac
  # Encoded dots too: a server or proxy that decodes them would take the token out of the API.
  case "$(lower "$1")" in *%2e*) fail bad_path "$bad" ;; esac
  case "$1" in /*) URL="$ISSUER/api/v1$1" ;; *) URL="$ISSUER/api/v1/$1" ;; esac
  case "$URL" in "$ISSUER"/api/v1/*) ;; *) fail bad_path "$bad" ;; esac
  case "$URL" in */../* | */./* | */.. | */.) fail bad_path "$bad" ;; esac
}

# api_call METHOD TOKEN [BODYFILE]
api_call() {
  settings=$(printf 'header = "Authorization: Bearer %s"' "$2")
  if [ -n "${3:-}" ]; then settings=$(printf '%s\nheader = "Content-Type: application/json"\ndata-binary = "@%s"' "$settings" "$3"); fi
  http "$1" "$URL" "$settings" || fail unreachable "$UNREACHABLE"
}

cmd_api() {
  method=$1
  api_url "${2:-}"
  bodyfile=""
  if [ "$method" = POST ]; then
    secure_dir
    tmpdir
    bodyfile="$TMPD/body.$(rand 6)"
    if [ -n "$JSON_FILE" ]; then
      cat -- "$JSON_FILE" >"$bodyfile" 2>/dev/null || fail bad_body "Cannot read $JSON_FILE."
    else
      if [ -n "$JSON_BODY" ]; then printf '%s' "$JSON_BODY" >"$bodyfile"; else printf '{}' >"$bodyfile"; fi
    fi
    first=$(tr -d ' \t\r\n' <"$bodyfile" | cut -c1)
    case "$first" in "{" | "[") ;; *) fail bad_body "The body is not JSON." ;; esac
  fi
  access_token
  api_call "$method" "$TOKEN" "$bodyfile"
  if [ "$STATUS" = 401 ]; then
    access_token "$TOKEN"
    api_call "$method" "$TOKEN" "$bodyfile"
  fi
  case "$STATUS" in
    2??)
      cat "$RESP"
      [ -s "$RESP" ] && [ "$(tail -c1 "$RESP" | od -An -c | tr -d ' ')" != '\n' ] && printf '\n'
      return 0
      ;;
  esac
  if [ "$STATUS" = 403 ] && [ "$(jstr error "$RESP")" = not_allowed ]; then
    fail insufficient_scope "This agent was connected without instance access. Ask the person, then run: n8n-ops connect --replace"
  fi
  http_fail "$method ${2:-}"
}

cmd_disconnect() {
  acquire
  if ! record_read; then
    printf '{"status":"not_connected"}\n'
    return 0
  fi
  assert_mine
  left=""
  for t in $R_refreshToken $R_toRevoke; do
    if oauth /oauth/revoke "token=$t" "token_type_hint=refresh_token" && [ "$STATUS" = 200 ]; then :; else left="$left $t"; fi
  done
  if [ -n "$left" ]; then
    R_refreshToken='' R_accessToken='' R_accessExpiresAt=0 R_toRevoke=$(printf '%s' "$left" | sed 's/^ *//')
    record_write
    fail disconnect_failed "n8n-ops did not confirm the disconnect. Run it again, or disconnect this agent in n8n-ops Settings."
  fi
  record_remove
  printf '{"status":"disconnected"}\n'
}

COMMAND=${1:-help}
[ $# -gt 0 ] && shift
URL_OPTION="" REPLACE=0 WAIT=0 JSON_BODY="" JSON_FILE="" ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL_OPTION=${2:-} && shift ;;
    --replace) REPLACE=1 ;;
    --wait) WAIT=1 ;;
    --json) JSON_BODY=${2:-} && shift ;;
    --json-file) JSON_FILE=${2:-} && shift ;;
    *) [ -z "$ARG" ] && ARG=$1 ;;
  esac
  shift
done

case "$COMMAND" in
  help | --help | -h)
    printf '%s\n' "$HELP"
    exit 0
    ;;
esac
setup
case "$COMMAND" in
  status) cmd_status ;;
  connect) if [ "$WAIT" = 1 ]; then cmd_wait; else cmd_connect; fi ;;
  get) cmd_api GET "$ARG" ;;
  post) cmd_api POST "$ARG" ;;
  disconnect) cmd_disconnect ;;
  *) fail unknown_command "Unknown command \"$COMMAND\". Run: n8n-ops help" ;;
esac
