#!/bin/sh
# n8n-ops for agents on Linux and macOS without Node: plain POSIX sh, curl and awk, nothing else.
#
# One of three versions with one contract (see n8n-ops.mjs): same commands, same JSON output and error codes,
# same files and the same lock, so they can run side by side. Tokens never appear in the output, and never on a
# command line (other users can read those): curl reads them from its standard input.
# R_* fields are read and written through eval (record_read, record_write).
# shellcheck disable=SC2034
set -u
set -f
umask 077

# ==== Product constants: the same values in all three versions and the entry point. ====
PRODUCT="n8n-ops"
CMD="n8n-ops"
# Environment variables are this prefix plus URL, CREDENTIALS, AGENT_NAME, NO_NODE, WAIT_SECONDS, LOCK_WAIT_MS.
ENV_PREFIX="N8N_OPS_"
# The credentials folder, in the user's home folder.
CREDENTIALS_FOLDER=".n8n-ops"
CLIENT_ID="n8n-ops-cli"
SCOPE="ops:read ops:access"
# The REST API as a resource (RFC 8707): the audience its access tokens are bound to.
RESOURCE="/api/v1"
# Every API call is under one of these prefixes (separated by spaces), so the token goes only to the API.
PREFIXES="/api/v1/"
# A path template in the endpoints list (an awk pattern): under PREFIXES, with {name} and {name:path} parts.
TEMPLATE_RE='^/api/v1/[A-Za-z0-9._~{}:/-]*$'
ACCESS_PATH="/api/v1/agent/access"
ENDPOINTS_PATH="/api/v1/agent/endpoints"
# The authorization server's device, token and revocation endpoints, after the address.
DEVICE_PATH="/oauth/device"
TOKEN_PATH="/oauth/token"
REVOKE_PATH="/oauth/revoke"
SKILL_HEADER_NAME="x-n8n-ops-skill"
POLICY_HEADER_NAME="x-n8n-ops-policy"
# The header that carries the kind (read or act) the client found for a call, with the policy revision.
KIND_HEADER_NAME="x-n8n-ops-kind"
KINDS_MAGIC="n8n-ops-kinds"
# Filled in with the address when the server serves this file.
DEFAULT_URL="__N8N_OPS_URL__"
# Filled in with the skill's version when the server serves this file; access then says when a newer one is out.
SKILL_VERSION="__N8N_OPS_SKILL_VERSION__"
# A copy that was not served (installed from Git) sends r<SKILL_REVISION> instead; raise it with the server's copy.
SKILL_REVISION=1
# ==== End of product constants. ====

# envv NAME: the product's environment variable NAME (the prefix plus NAME), empty when unset.
envv() { eval "printf '%s' \"\${${ENV_PREFIX}$1:-}\""; }

case "$SKILL_VERSION" in __*) SKILL_HEADER="r$SKILL_REVISION" ;; *) SKILL_HEADER=$SKILL_VERSION ;; esac
v=$(envv WAIT_SECONDS)
WAIT_SECONDS="${v:-90}"
# A pending code is dropped locally only this long after its expiry: until then the server decides.
STALE_CODE_SECONDS=600
v=$(envv TEST_POLL_SECONDS)
POLL_SECONDS="${v:-5}"
# A refresh is retried only once it cannot be in flight any more: twice the request timeout (tests shorten it).
v=$(envv TEST_REFRESH_GRACE)
REFRESH_GRACE="${v:-30}"
v=$(envv LOCK_WAIT_MS)
LOCK_WAIT_MS="${v:-20000}"
# The server answers an API call within 60 s (or says the outcome is unknown); tests shorten it.
v=$(envv TEST_API_TIMEOUT_MS)
API_TIMEOUT_MS="${v:-75000}"
# Wait before the one retry of a call the server refused as busy (tests shorten it).
v=$(envv TEST_BUSY_WAIT_MS)
BUSY_WAIT_MS="${v:-2000}"
KINDS_MAX_AGE=3600
KINDS_FORMAT=2
UNKNOWN_OUTCOME="The action may have run. Read its state before trying again."
NOT_LISTED="This connection has no such call. Take the path from \`$CMD endpoints\`, with its {...} parts filled in; never guess it."
UNAVAILABLE="The list of allowed calls could not be read from $PRODUCT, so nothing was sent. Try again in a moment."
NO_ACCESS_SCOPE="This agent may not request access to n8n instances. Ask the person to allow it, then run: $CMD connect --replace"
POLICY_CHANGED="$PRODUCT's calls changed, or this path names a different call than the list says. Nothing ran. Run \`$CMD endpoints\` and take the path from it."
FIELDS="v:n issuer:s label:s generation:s refreshToken:s accessToken:s accessExpiresAt:n scope:s refreshStartedAt:n refreshRetried:n deviceCode:s userCode:s link:s deviceExpiresAt:n interval:n nextPollAt:n toRevoke:s"

LOCKTOKEN=""
TMPD=""
SECURED=0
CHECKED=0
# The last answer (http): its file, and 1 when it is complete JSON.
RESP="" RESP_JSON=0
FAIL_STATUS=""
# The call being sent (api_send): its kind, the revision of the list it was classified with (empty: exempt), its
# path, and whether each retry was used. SOFT=1 makes a failed request return instead of stopping (the listing).
KIND=read REVISION="" CALL_PATH="" BOTH=0 SOFT=0
s_ref=0 s_busy=0 s_net=0 s_pol=0

now() { date +%s; }
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
host() { uname -n; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
nap() { sleep "$1" 2>/dev/null || sleep 1; }
seconds() { awk -v m="$1" 'BEGIN { printf "%.3f", m / 1000 }'; }
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
  st=""
  [ -n "$FAIL_STATUS" ] && st=",\"status\":$FAIL_STATUS"
  if [ $# -ge 3 ] && [ -s "$3" ] && [ "$(json_scan valid "$3")" = 1 ]; then
    first=$(tr -d ' \t\r\n' <"$3" | cut -c1)
    case "$first" in "{" | "[") body=",\"body\":$(tr -d '\r\n' <"$3")" ;; esac
  fi
  printf '{"error":"%s","message":"%s"%s%s}\n' "$1" "$(esc "$2")" "$st" "$body"
  exit 1
}

# Reading flat JSON: one string or number field; values with escapes do not match and read as empty. An answer is
# read only when it is complete JSON (RESP_JSON, from json_scan).
jstr() {
  [ "$2" != "$RESP" ] || [ "$RESP_JSON" = 1 ] || return 0
  tr -d '\r\n' <"$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p'
}
jnum() {
  v=""
  if [ "$2" != "$RESP" ] || [ "$RESP_JSON" = 1 ]; then
    v=$(tr -d '\r\n' <"$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  fi
  printf '%s' "${v:-0}"
}
secret_ok() { case "$1" in "" | *[!A-Za-z0-9._~+/=-]*) return 1 ;; esac }
plain_ok() { case "$1" in *[\"\\]*) return 1 ;; esac }
# The policy revision the server gives with its list: a short token, safe in a header and in the kinds file.
revision_ok() {
  case "$1" in "" | *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ ${#1} -le 128 ]
}

# json_scan MODE FILE [KEY]: a small, strict JSON reader. It reads a file only when the whole file is one complete
# JSON value with nothing after it but whitespace, as JSON.parse reads it (RFC 8259: no single quotes, names
# without quotes, comments, trailing commas, leading zeros or raw control characters in a string); otherwise it
# reads nothing, so a broken answer holds no refusal marker and no list. A key given twice counts as JSON.parse
# reads it: the last value wins, and a later value that is not a string clears an earlier string. Compared values
# have their escapes read (\u0062usy is busy).
# "valid" prints 1 when the file is such JSON, else 0. "failed" prints 1 when the top object says "success": false
# or "status": "error", else 0. "top" prints the top object's string field KEY (never one nested deeper). "kinds"
# prints "METHOD PATH KIND" for each object of the top object's "endpoints" list, "L" when that list is an array,
# and "R REVISION" when the top object's "revision" is a string.
json_scan() {
  # NUL becomes another control character, which no JSON holds as it is, so that every awk reads the whole file.
  tr '\000' '\001' <"$2" | LC_ALL=C awk -v mode="$1" -v key="${3:-}" '
function hexv(c) { return index("0123456789abcdef", tolower(c)) - 1 }
# A string as JSON.parse reads it, for comparing: an escape of printable ASCII becomes its character; any other
# stays \u and four hex digits, which no value compared here holds.
function unesc(s,   out, i, c, n, v) {
  out = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c != "\\") { out = out c; continue }
    i++; c = substr(s, i, 1); v = -1
    if (c == "u") {
      v = hexv(substr(s, i + 1, 1)) * 4096 + hexv(substr(s, i + 2, 1)) * 256 + hexv(substr(s, i + 3, 1)) * 16 + hexv(substr(s, i + 4, 1))
      i += 4
    } else if (c == "b") v = 8
    else if (c == "f") v = 12
    else if (c == "n") v = 10
    else if (c == "r") v = 13
    else if (c == "t") v = 9
    if (v < 0) out = out c
    else if (v >= 32 && v < 127) out = out sprintf("%c", v)
    else out = out sprintf("\\u%04x", v)
  }
  return out
}
# A value starts in the open container at depth: kind s (string), l (number or literal), { or [.
function assign(kind, v,   k) {
  k = cur[depth]
  if (depth == 1 && typ[1] == "{") {
    if (mode == "top" && k == key) topv = (kind == "s") ? v : ""
    if (mode == "failed" && k == "success") succ = (kind == "l" && v == "false")
    if (mode == "failed" && k == "status") stat = (kind == "s" && v == "error")
    if (mode == "kinds" && k == "revision") { seenrev = (kind == "s"); rev = v }
    # Only the last list counts: the rows of an earlier one are dropped.
    if (mode == "kinds" && k == "endpoints") { list = (kind == "["); rows = "" }
  } else if (mode == "kinds" && depth == 3 && typ[3] == "{" && typ[2] == "[" && ckey[2] == "endpoints") {
    if (k == "method") em = (kind == "s") ? v : ""
    if (k == "path") ep = (kind == "s") ? v : ""
    if (k == "kind") ek = (kind == "s") ? v : ""
  }
}
function ended() { state = (depth > 0) ? "x" : "e" }
{ text = text $0 "\n" }
END {
  # States: v a value, f a value or ], k a key, K a key or }, c a colon, x a comma or the close, e the end.
  n = length(text); i = 1; depth = 0; state = "v"; bad = 0
  succ = 0; stat = 0; topv = ""; list = 0; rows = ""; seenrev = 0; rev = ""
  while (i <= n) {
    c = substr(text, i, 1)
    if (c == " " || c == "\t" || c == "\n" || c == "\r") { i++; continue }
    if (state == "e") { bad = 1; break }
    if (c == "\"") {
      j = i + 1; ok = 0
      while (j <= n) {
        d = substr(text, j, 1)
        if (d == "\"") { ok = 1; break }
        if (d == "\\") {
          d = substr(text, j + 1, 1)
          if (d != "" && index("\"\\/bfnrt", d)) { j += 2; continue }
          if (d == "u" && substr(text, j + 2, 4) ~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/) { j += 6; continue }
          break
        }
        # A control character, which JSON writes only as an escape.
        if (d < " ") break
        j++
      }
      if (!ok) { bad = 1; break }
      s = unesc(substr(text, i + 1, j - i - 1)); i = j + 1
      if (state == "k" || state == "K") { cur[depth] = s; state = "c"; continue }
      if (state != "v" && state != "f") { bad = 1; break }
      assign("s", s); ended(); continue
    }
    if (c == "-" || c ~ /^[0-9]$/) {
      j = i
      if (c == "-") j++
      d = substr(text, j, 1)
      if (d == "0") j++
      else if (d ~ /^[1-9]$/) { while (substr(text, j, 1) ~ /^[0-9]$/) j++ }
      else { bad = 1; break }
      if (substr(text, j, 1) == ".") {
        j++
        if (substr(text, j, 1) !~ /^[0-9]$/) { bad = 1; break }
        while (substr(text, j, 1) ~ /^[0-9]$/) j++
      }
      d = substr(text, j, 1)
      if (d == "e" || d == "E") {
        j++; d = substr(text, j, 1)
        if (d == "+" || d == "-") j++
        if (substr(text, j, 1) !~ /^[0-9]$/) { bad = 1; break }
        while (substr(text, j, 1) ~ /^[0-9]$/) j++
      }
      lit = substr(text, i, j - i); i = j
    } else if (substr(text, i, 4) == "true" || substr(text, i, 4) == "null") { lit = substr(text, i, 4); i += 4 }
    else if (substr(text, i, 5) == "false") { lit = "false"; i += 5 }
    else lit = ""
    if (lit != "") {
      if (state != "v" && state != "f") { bad = 1; break }
      assign("l", lit); ended(); continue
    }
    if (c == "{" || c == "[") {
      if (state != "v" && state != "f") { bad = 1; break }
      assign(c, "")
      ckey[depth + 1] = (typ[depth] == "{") ? cur[depth] : ""
      depth++; typ[depth] = c; cur[depth] = ""
      if (depth == 3) { em = ""; ep = ""; ek = "" }
      state = (c == "{") ? "K" : "f"; i++; continue
    }
    if (c == "}" || c == "]") {
      if (c == "}" && state != "K" && !(state == "x" && typ[depth] == "{")) { bad = 1; break }
      if (c == "]" && state != "f" && !(state == "x" && typ[depth] == "[")) { bad = 1; break }
      # Anything but an explicit read counts as an act.
      if (mode == "kinds" && depth == 3 && typ[3] == "{" && typ[2] == "[" && ckey[2] == "endpoints" && em != "" && ep != "")
        rows = rows em " " ep " " (ek == "read" ? "read" : "act") "\n"
      depth--; i++; ended(); continue
    }
    if (c == ":" && state == "c") { state = "v"; i++; continue }
    if (c == "," && state == "x") { state = (typ[depth] == "{") ? "k" : "v"; i++; continue }
    bad = 1; break
  }
  if (state != "e") bad = 1
  if (mode == "valid") print (bad ? 0 : 1)
  if (mode == "failed") print ((!bad && (succ || stat)) ? 1 : 0)
  if (bad) exit 0
  if (mode == "top") printf "%s", topv
  if (mode == "kinds") {
    printf "%s", rows
    if (list) print "L"
    if (seenrev) print "R " rev
  }
}'
}

# json_string FILE: the file as one JSON string.
json_string() {
  nl=0
  [ -s "$1" ] && [ "$(tail -c1 "$1" | od -An -c | tr -d ' ')" = '\n' ] && nl=1
  tr -d '\000-\010\013\014\016-\037' <"$1" | awk -v nl="$nl" '
BEGIN { printf "%s", "\"" }
{
  if (NR > 1) printf "%s", "\\n"
  n = length($0); out = ""
  for (i = 1; i <= n; i++) {
    c = substr($0, i, 1)
    if (c == "\\") out = out "\\\\"
    else if (c == "\"") out = out "\\\""
    else if (c == "\t") out = out "\\t"
    else if (c == "\r") out = out "\\r"
    else out = out c
  }
  printf "%s", out
}
END { if (nl == 1) printf "%s", "\\n"; printf "%s", "\"" }'
}

HELP="$CMD: use $PRODUCT after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to $WAIT_SECONDS s for the approval; run again while it answers still_waiting.
  access                What this connection may read or act on, and until when.
  endpoints [area]      The calls this connection may make, with their kind (read or act).
  get <path>            GET a path, for example: get '/api/v1/problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this computer user is connected (no secrets).
  disconnect            End this computer user's connection.

  --url <address>       The $PRODUCT address (or ${ENV_PREFIX}URL). Kept once connected, for the commands after."

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else openssl dgst -sha256 -r; fi
}

# The server's address and where its connection is kept, one per address for this computer user. The connection
# belongs to the computer user, not to the skill's folder, which is never written.
# The address: --url, the environment, the one filled in when the server served this file, or the one kept on
# connecting.
setup() {
  command -v curl >/dev/null 2>&1 || fail missing_curl "curl is needed. Install curl, or Node 20 or later."
  creds=$(envv CREDENTIALS)
  [ -n "${HOME:-}" ] || [ -n "$creds" ] || fail cannot_save "HOME is not set, so there is no folder to keep the connection in."
  DIR="${creds:-${HOME:-}/$CREDENTIALS_FOLDER}"
  case "$DIR" in /*) ;; *) DIR="$(pwd -P)/$DIR" ;; esac
  plain_ok "$DIR" || fail insecure_credentials "The $CMD folder's path cannot contain quotes or backslashes."
  ADDRESS="$DIR/address"
  raw="${URL_OPTION:-$(envv URL)}"
  if [ -z "$raw" ]; then case "$DEFAULT_URL" in __*) ;; *) raw="$DEFAULT_URL" ;; esac fi
  KEPT=""
  [ -n "$raw" ] || kept_address
  [ -n "$raw" ] || raw=$KEPT
  [ -n "$raw" ] || fail no_url "No $PRODUCT address. Ask the person for it, then run: $CMD connect --url \"<address>\""
  # A kept address is one line: anything else in the file makes it invalid, not a different address.
  if [ -n "$KEPT" ]; then case "$KEPT" in *[[:space:]]*) bad_url "" ;; esac fi
  given=$raw
  raw=${raw%/}
  case "$raw" in
    https://*) rest=${raw#https://} PROTO=https ;;
    http://*) rest=${raw#http://} PROTO=http ;;
    *) bad_url "The address must start with https:// (http only for this computer)." ;;
  esac
  hostpart=$(lower "$rest")
  case "$hostpart" in
    "["*"]" | "["*"]:"*)
      # An IPv6 address, written as a browser writes it.
      inner=${hostpart#\[}
      port=${inner#*]}
      inner=${inner%%]*}
      case "$inner" in "" | *[!0-9a-f:.]*) bad_url "\"$given\" is not an address." ;; esac
      v6=$(ipv6_text "$inner") || bad_url "\"$given\" is not an address."
      name="[$v6]"
      ;;
    "" | *[!a-z0-9.:-]* | :* | *:*:*) bad_url "Use the address alone, for example https://n8n-ops.example.com." ;;
    *) name=${hostpart%%:*} port=${hostpart#"$name"} ;;
  esac
  # A port is digits only, 1 to 65535.
  case "$port" in
    "") ;;
    :[1-9] | :[1-9][0-9] | :[1-9][0-9][0-9] | :[1-9][0-9][0-9][0-9] | :[1-9][0-9][0-9][0-9][0-9])
      [ "${port#:}" -le 65535 ] || bad_url "Use the address alone, for example https://n8n-ops.example.com."
      ;;
    *) bad_url "Use the address alone, for example https://n8n-ops.example.com." ;;
  esac
  if [ "$PROTO" = http ]; then
    case "$name" in 127.0.0.1 | localhost | "[::1]") ;; *) bad_url "The address must start with https:// (http only for this computer)." ;; esac
  fi
  # As a browser writes the origin: lower case, no default port.
  case "$PROTO$port" in https:443 | http:80) port="" ;; esac
  ISSUER="$PROTO://$name$port"
  key=$(printf '%s' "$ISSUER" | sha | cut -c1-32)
  FILE="$DIR/$key.json"
  LOCK="$DIR/$key.lock"
  KINDS="$DIR/$key.kinds"
  # What the connection is called on the approval page and in the product's list of connections.
  agent=$(envv AGENT_NAME)
  if [ -n "$agent" ]; then
    LABEL=$(printf '%s' "$agent" | cut -c1-60)
  else
    LABEL=$(printf 'Agents on %s' "$(host)" | cut -c1-60)
  fi
}

# ipv6_text ADDRESS: an IPv6 address (lower case, without its brackets) as a browser writes it, or a failure when it
# is not one: the WHATWG URL standard's parser and serializer, as Node has them. No leading zeros, the first longest
# run of two or more zero groups as ::, and a dotted IPv4 end in hex.
ipv6_text() {
  printf '%s\n' "$1" | LC_ALL=C awk '
function hv(c) { return (c == "") ? -1 : index("0123456789abcdef", c) - 1 }
NR == 1 {
  s = $0; n = length(s); p = 1; piece = 0; compress = -1
  for (k = 0; k < 8; k++) a[k] = 0
  if (substr(s, 1, 1) == ":") {
    if (substr(s, 2, 1) != ":") exit 1
    p = 3; piece = 1; compress = 1
  }
  while (p <= n) {
    if (piece == 8) exit 1
    if (substr(s, p, 1) == ":") {
      if (compress >= 0) exit 1
      p++; piece++; compress = piece; continue
    }
    value = 0; len = 0
    while (len < 4 && hv(substr(s, p, 1)) >= 0) { value = value * 16 + hv(substr(s, p, 1)); p++; len++ }
    c = substr(s, p, 1)
    if (c == ".") {
      # A dotted IPv4 end: four decimal numbers of 0 to 255 without leading zeros, as the last two groups.
      if (len == 0 || piece > 6) exit 1
      p -= len; seen = 0
      while (p <= n) {
        if (seen > 0) { if (substr(s, p, 1) == "." && seen < 4) p++; else exit 1 }
        d = hv(substr(s, p, 1))
        if (d < 0 || d > 9) exit 1
        v4 = -1
        while ((d = hv(substr(s, p, 1))) >= 0 && d <= 9) {
          if (v4 == 0) exit 1
          if (v4 < 0) v4 = 0
          v4 = v4 * 10 + d
          if (v4 > 255) exit 1
          p++
        }
        a[piece] = a[piece] * 256 + v4; seen++
        if (seen == 2 || seen == 4) piece++
      }
      if (seen != 4) exit 1
      break
    }
    if (p <= n) {
      if (c != ":") exit 1
      p++
      if (p > n) exit 1
    }
    a[piece] = value; piece++
  }
  if (compress >= 0) {
    swaps = piece - compress; piece = 7
    while (piece != 0 && swaps > 0) {
      t = a[piece]; a[piece] = a[compress + swaps - 1]; a[compress + swaps - 1] = t
      piece--; swaps--
    }
  } else if (piece != 8) exit 1
  best = -1; bestlen = 1; i = 0
  while (i < 8) {
    if (a[i] != 0) { i++; continue }
    j = i
    while (j < 8 && a[j] == 0) j++
    if (j - i > bestlen) { best = i; bestlen = j - i }
    i = j
  }
  out = ""
  for (i = 0; i < 8; i++) {
    if (i == best) { out = out ((i == 0) ? "::" : ":"); i += bestlen - 1; continue }
    out = out sprintf("%x", a[i])
    if (i != 7) out = out ":"
  }
  print out
  exit 0
}'
}

# An address that is not one: from the kept file, the file is what is wrong.
bad_url() {
  [ -z "$KEPT" ] || fail no_url "The address kept in $ADDRESS is not valid. Pass --url \"<address>\"."
  fail insecure_url "$1"
}

# The file that keeps the address of the last working connection, so a copy of the skill without one finds it.
kept_address() {
  [ -e "$ADDRESS" ] || [ -L "$ADDRESS" ] || return 0
  [ -f "$ADDRESS" ] && [ ! -L "$ADDRESS" ] || fail insecure_credentials "$ADDRESS must be a plain file."
  check_private "$ADDRESS"
  # The whole file (x keeps the line breaks at its end), without the line breaks at its end.
  KEPT=$(
    cat "$ADDRESS"
    printf x
  )
  KEPT=${KEPT%x}
  cr=$(printf '\r')
  nl='
'
  while :; do
    case "$KEPT" in
      *"$cr" | *"$nl") KEPT=${KEPT%?} ;;
      *) break ;;
    esac
  done
}

# Keeps the address of a working connection, in one step. Only a convenience: a failure changes nothing (so it
# runs in a subshell, where a failure stops only the subshell, and says nothing).
keep_address() {
  (
    trap - EXIT INT TERM HUP
    KEPT=""
    kept_address
    [ "$KEPT" = "$ISSUER" ] && exit 0
    secure_dir
    t="$ADDRESS.$(rand 6).tmp"
    if (
      set -C
      printf '%s\n' "$ISSUER" >"$t"
    ) 2>/dev/null && mv -f "$t" "$ADDRESS" 2>/dev/null; then exit 0; fi
    rm -f "$t"
  ) >/dev/null 2>&1 || :
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

# Before the connection's file is read: the folder must still be one only this user can open, since a restore or a
# change of its mode may have opened it since secure_dir set it up. Checks only, never changes it; once per command.
check_dir() {
  [ "$SECURED" = 1 ] && return 0
  [ "$CHECKED" = 1 ] && return 0
  [ -d "$DIR" ] || fail insecure_credentials "$DIR must be a plain folder."
  check_private "$DIR"
  CHECKED=1
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
  check_dir
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

# write_private TARGET TEXTFILE: moves a file written in the temp folder over TARGET, in one step.
write_private() {
  sync -- "$2" 2>/dev/null || :
  mv -f "$2" "$1" 2>/dev/null || fail cannot_save "Cannot replace $1."
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
        plain_ok "$v" || fail unexpected_answer "$PRODUCT sent a value that cannot be stored ($k)."
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
  write_private "$FILE" "$tmp"
}

record_remove() { rm -f "$FILE" "$KINDS"; }

# The lock: a file created exclusively, naming its holder. Never taken from a live holder, however old.

lock_field() { printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p'; }

hook() {
  name=$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')
  at=$(envv "TEST_HOLD_$name")
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
        fail busy "Another $CMD command has held $LOCK for over 10 minutes. If none is running, delete that file."
      fi
      fail busy "Another $CMD command is using this connection. Nothing was sent; run it again."
    fi
    # Reached only while another live process holds the lock: the tests wait for it instead of for a fixed time.
    hook lock-busy
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

assert_mine() { mine || fail busy "Another $CMD command took over this connection. Run it again."; }

# Requests. http METHOD URL [SETTINGS [TIMEOUT_MS]]: SETTINGS are more curl settings, with the secrets; curl reads
# them from its standard input (printf is built in, so they are on no command line). Sets STATUS, CTYPE, RESP, HDRS
# (the answer's headers) and SENT (no when the name, the connection or TLS failed first, so nothing reached the
# server).
http() {
  tmpdir
  RESP="$TMPD/resp.$(rand 6)"
  HDRS="$TMPD/hdr.$(rand 6)"
  errf="$TMPD/err.$(rand 6)"
  out=$(printf 'url = "%s"\nrequest = "%s"\nheader = "Accept: application/json"\n%s\n' "$2" "$1" "${3:-}" |
    curl -q -sS -K - --proto "=$PROTO" --max-time "$(seconds "${4:-15000}")" --connect-timeout 10 \
      -D "$HDRS" -o "$RESP" -w '%{http_code} %{content_type}' 2>"$errf")
  rc=$?
  STATUS=${out%% *}
  CTYPE=$(lower "${out#* }")
  SENT=yes
  RESP_JSON=0
  if [ $rc -ne 0 ]; then
    case $rc in 5 | 6 | 7 | 35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 83 | 90 | 91) SENT=no ;; esac
    UNREACHABLE="Cannot reach $ISSUER ($(tr -d '\r\n' <"$errf" | cut -c1-120))."
    return 1
  fi
  RESP_JSON=$(json_scan valid "$RESP")
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

# The top object's own text about a failure, as the other versions take it (none when the answer is not JSON); a
# text with escapes left in it is not shown.
http_fail() {
  detail=""
  for f in error_description message detail error; do
    [ -n "$detail" ] || detail=$(json_scan top "$RESP" "$f")
    case "$detail" in *\\*) detail="" ;; esac
  done
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
    fail unexpected_answer "$PRODUCT answered without usable tokens."
  fi
  R_refreshToken=$rt R_accessToken=$at R_scope=$sc R_accessExpiresAt=$(($(now) + ex))
}

revoke_pending() {
  [ -n "$R_toRevoke" ] || return 0
  left=""
  for t in $R_toRevoke; do
    if oauth "$REVOKE_PATH" "token=$t" "token_type_hint=refresh_token" && [ "$STATUS" = 200 ]; then :; else left="$left $t"; fi
  done
  left=$(printf '%s' "$left" | sed 's/^ *//')
  if [ "$left" != "$R_toRevoke" ]; then
    R_toRevoke=$left
    record_write
  fi
}

clear_pending() { R_deviceCode='' R_userCode='' R_link='' R_deviceExpiresAt=0 R_interval=0 R_nextPollAt=0; }

# The hint names the address, so the wait asks the same server even if the kept address changes meanwhile. Quoted:
# a shell would take the brackets of an IPv6 address as a file pattern.
print_pending() {
  left=$((R_deviceExpiresAt - $(now)))
  [ $left -lt 0 ] && left=0
  printf '{"status":"pending","link":"%s","code":"%s","expiresIn":%s,"next":"End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: %s connect --wait --url %s"}\n' \
    "$(esc "$R_link")" "$(esc "$R_userCode")" "$left" "$CMD" "$(esc "\"$ISSUER\"")"
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
  # Before any code exists: can it keep a connection here, and is the server there?
  secure_dir
  probe="$DIR/.probe-$(rand 4)"
  if ! (
    set -C
    : >"$probe"
  ) 2>/dev/null; then fail cannot_save "Cannot write in $DIR. Allow this agent to write there."; fi
  rm -f "$probe"
  http GET "$ISSUER/.well-known/oauth-authorization-server" || fail unreachable "$UNREACHABLE"
  if [ "$STATUS" != 200 ] || [ "$(jstr issuer "$RESP")" != "$ISSUER" ]; then
    fail unreachable "$ISSUER does not answer as $PRODUCT with agents allowed ($STATUS). Check the address, and ask an administrator to allow agents in $PRODUCT's settings."
  fi
  acquire
  record_read || :
  revoke_pending
  if [ -n "$R_refreshToken" ] && [ "$REPLACE" != 1 ]; then
    keep_address
    printf '{"status":"already_connected","label":"%s","scope":"%s"}\n' "$(esc "$R_label")" "$(esc "$R_scope")"
    return 0
  fi
  # The open code again, unless asked for a new one (--replace: the link did not work for the person).
  if [ -n "$R_deviceCode" ] && [ $((R_deviceExpiresAt - $(now))) -gt 30 ] && [ "$REPLACE" != 1 ]; then
    print_pending
    return 0
  fi
  assert_mine
  oauth "$DEVICE_PATH" "scope=$SCOPE" "resource=$ISSUER$RESOURCE" "client_label=$LABEL" || fail unreachable "$UNREACHABLE"
  [ "$STATUS" = 200 ] || http_fail "Asking to connect"
  dc=$(jstr device_code "$RESP")
  uc=$(jstr user_code "$RESP")
  link=$(jstr verification_uri_complete "$RESP")
  secret_ok "$dc" || fail unexpected_answer "$PRODUCT answered without a code."
  case "$uc" in "" | *[!A-Z0-9-]*) fail unexpected_answer "$PRODUCT answered without a code." ;; esac
  case "$link" in "$ISSUER"/*) ;; *) fail unexpected_answer "The approval link is not on $PRODUCT." ;; esac
  plain_ok "$link" || fail unexpected_answer "$PRODUCT answered without a code."
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
        keep_address
        printf '{"status":"connected","label":"%s","scope":"%s"}\n' "$(esc "$R_label")" "$(esc "$R_scope")"
        return 0
      fi
      fail not_connected "No connection is being made. Run: $CMD connect"
    fi
    t=$(now)
    if [ $((R_deviceExpiresAt + STALE_CODE_SECONDS)) -le "$t" ]; then
      clear_pending
      record_write
      fail expired "The code expired before it was approved. Run: $CMD connect"
    fi
    wait=0
    if [ "$R_nextPollAt" -gt "$t" ]; then
      wait=$((R_nextPollAt - t))
    else
      assert_mine
      if ! oauth "$TOKEN_PATH" "grant_type=urn:ietf:params:oauth:grant-type:device_code" "device_code=$R_deviceCode"; then
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
        rm -f "$KINDS"
        revoke_pending
        keep_address
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
          fail expired "The code is no longer valid. Run: $CMD connect"
          ;;
        *) http_fail "Waiting for the approval" ;;
      esac
    fi
    release
    if [ $(($(now) + wait)) -gt "$until" ]; then
      printf '{"status":"still_waiting","next":"Not approved yet. Run again: %s connect --wait --url %s"}\n' "$CMD" "$(esc "\"$ISSUER\"")"
      return 0
    fi
    sleep "$wait"
  done
}

usable() { [ -n "$R_accessToken" ] && [ $((R_accessExpiresAt - $(now))) -gt 60 ] && [ "$R_refreshStartedAt" = 0 ]; }

# access_token [STALE]: sets TOKEN to a live access token: the stored one while it lasts, else one refresh.
access_token() {
  stale=${1:-}
  record_read || fail not_connected "Not connected. Run: $CMD connect"
  [ -n "$R_refreshToken" ] || fail not_connected "Not connected. Run: $CMD connect"
  if [ -z "$stale" ] && usable; then
    TOKEN=$R_accessToken
    return 0
  fi
  acquire
  record_read || fail not_connected "Not connected. Run: $CMD connect"
  [ -n "$R_refreshToken" ] || fail not_connected "Not connected. Run: $CMD connect"
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
    fail busy "Another $CMD command is refreshing this connection. Nothing was sent; run it again."
  fi
  if [ "$R_refreshStartedAt" != 0 ]; then
    # The last refresh got no answer; trying once more either continues the connection or ends it there.
    [ "$R_refreshRetried" != 0 ] && fail connection_ended "Two refreshes got no answer, so this connection cannot be trusted. Run: $CMD connect --replace"
    R_refreshRetried=1
  fi
  R_refreshStartedAt=$(now)
  record_write
  assert_mine
  hook before-refresh
  if ! oauth "$TOKEN_PATH" "grant_type=refresh_token" "refresh_token=$R_refreshToken" "resource=$ISSUER$RESOURCE"; then
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
      # The lock was taken while this one waited for the server: keep the new tokens anyway, under a fresh lock.
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
    # An old connection still to be ended (after --replace) keeps its place until the server confirms it.
    if [ -n "$R_toRevoke" ]; then
      keep=$R_toRevoke
      name=$R_label
      record_clear
      R_toRevoke=$keep R_label=$name
      record_write
    else
      record_remove
    fi
    fail connection_ended "This connection has ended (disconnected in $PRODUCT, its time ran out, sign-in settings changed, or its token was used twice). Run: $CMD connect"
  fi
  # The server answered with an error before spending the token (a 4xx); a 5xx may have come after.
  if [ "$STATUS" -lt 500 ]; then
    R_refreshStartedAt=$b_started R_refreshRetried=$b_retried
    record_write
  fi
  http_fail "Refreshing the connection"
}

# api_url PATH: sets URL (to send to), APATH (the path alone) and HASQ (1 when there is a query). The path is under
# one of PREFIXES, never anywhere else, so the token goes only to the API.
api_url() {
  bad="Give a path from \`$CMD endpoints\`, for example: get '/api/v1/problems?status=open' (percent-encode anything else)"
  p=$1
  case "$p" in "" | *://* | //* | *[!A-Za-z0-9._~!\$\&\'\(\)*+,\;=:@/?%-]*) fail bad_path "$bad" ;; esac
  # Encoded dots too: a server or proxy that decodes them would take the token out of the API.
  case "$(lower "$p")" in *%2e*) fail bad_path "$bad" ;; esac
  pathonly=${p%%\?*}
  # The kind is found from the path as it is sent, but a server may decode the path before it routes it. So in the
  # path an escape may not stand for a character a route template holds as it is (A-Z a-z 0-9 . _ ~ : -), nor for
  # / \ or % (/api/v1/problems/7%2Fsend would match /api/v1/problems/{id} here and may run /api/v1/problems/{id}/send
  # there), and
  # every % must start an escape. The query keeps any escape.
  case "$pathonly" in
    *% | *%? | *%[!0-9A-Fa-f]* | *%?[!0-9A-Fa-f]* | *%2[5DdEeFf]* | *%3[0-9Aa]* | *%4[1-9A-Fa-f]* | *%5[0-9AaCcFf]* | \
      *%6[1-9A-Fa-f]* | *%7[0-9AaEe]*) fail bad_path "$bad" ;;
  esac
  # Some servers drop ;parameters from a segment before they route (/api/v1/problems/export;x runs
  # /api/v1/problems/export).
  # The server's check of the declared kind stops such a call too; this refuses it before it is sent.
  case "$pathonly" in *\;*) fail bad_path "$bad" ;; esac
  prefixed=0
  for x in $PREFIXES; do
    case "$pathonly" in "$x"?*) prefixed=1 ;; esac
  done
  [ $prefixed = 1 ] || fail bad_path "$bad"
  case "$pathonly/" in */../* | */./*) fail bad_path "$bad" ;; esac
  URL="$ISSUER$p"
  APATH="$pathonly"
  HASQ=0
  case "$p" in *\?*) HASQ=1 ;; esac
}

# api_call METHOD URL TOKEN [BODYFILE]: the call, with the policy revision and the kind (KIND) unless it is exempt.
# The revision and the kind go together: the server runs the call only when both still hold for the route it picks.
api_call() {
  settings=$(printf 'header = "Authorization: Bearer %s"\nheader = "%s: %s"' "$3" "$SKILL_HEADER_NAME" "$SKILL_HEADER")
  if [ -n "$REVISION" ]; then
    settings=$(printf '%s\nheader = "%s: %s"\nheader = "%s: %s"' "$settings" "$POLICY_HEADER_NAME" "$REVISION" \
      "$KIND_HEADER_NAME" "$KIND")
  fi
  if [ -n "${4:-}" ]; then settings=$(printf '%s\nheader = "Content-Type: application/json"\ndata-binary = "@%s"' "$settings" "$4"); fi
  http "$1" "$2" "$settings" "$API_TIMEOUT_MS"
}

# The three refusals the server makes before any route code runs. Nothing ran, so the call may go again.
token_refused() { [ "$STATUS" = 401 ] && grep -i '^www-authenticate:' "$HDRS" 2>/dev/null | grep -q 'error="invalid_token"'; }
# Only the top object's own key error, exactly, with a string value counts (json_scan top): jstr would also find one
# nested in a route's own answer, or under another key case.
busy_refused() { [ "$STATUS" = 429 ] && [ "$(json_scan top "$RESP" error)" = busy ]; }
policy_refused() { [ "$STATUS" = 409 ] && [ "$(json_scan top "$RESP" error)" = policy_changed ]; }

# api_send METHOD URL BODYFILE: one API call with its retries, each at most once: after a 401 with the invalid_token
# challenge, a refresh and the call again; after a 429 busy, a wait and the call again; after a 409 policy_changed,
# the list again and the call again under its new kind. A path that a read and an act both match went as an act
# (BOTH=1); when the list read again still has both for it, it goes once more as a read (the router picked the read
# route). Every one of these follows a refusal made before any route code ran. Any other answer is the answer. For a
# read, one retry after a network failure; an act is never sent again once it may have reached the server. The call
# is KIND, REVISION, CALL_PATH and BOTH; sh has no local variables, so kinds_fetch keeps this loop's state around its
# own call (its listing never reaches the policy_changed branch, so BOTH stays as it is).
api_send() {
  access_token
  s_ref=0 s_busy=0 s_net=0 s_pol=0
  while :; do
    if ! api_call "$1" "$2" "$TOKEN" "$3"; then
      if [ "$KIND" = act ]; then
        [ "$SENT" = no ] && fail unreachable "$UNREACHABLE"
        fail outcome_unknown "$UNKNOWN_OUTCOME"
      fi
      if [ $s_net = 1 ]; then
        [ "$SOFT" = 1 ] && return 1
        fail unreachable "$UNREACHABLE"
      fi
      s_net=1
      continue
    fi
    if [ $s_ref = 0 ] && token_refused; then
      s_ref=1
      access_token "$TOKEN"
      continue
    fi
    if [ $s_busy = 0 ] && busy_refused; then
      s_busy=1
      nap "$(seconds "$BUSY_WAIT_MS")"
      continue
    fi
    if [ -n "$REVISION" ] && policy_refused; then
      if [ $s_pol = 1 ]; then
        FAIL_STATUS=$STATUS
        fail policy_changed "$POLICY_CHANGED"
      fi
      s_pol=1
      kinds_fetch
      k=$(kinds_lookup "$LISTF" "$1" "$CALL_PATH" "$LISTGEN")
      case "$k" in
        "read "* | "act "*) KIND=${k%% *} REVISION=${k#* } ;;
        "both "*)
          KIND=act REVISION=${k#* }
          [ "$BOTH" = 1 ] && KIND=read
          ;;
        *) fail bad_path "$NOT_LISTED" ;;
      esac
      continue
    fi
    if [ "$KIND" = act ] && [ "$STATUS" -ge 500 ]; then
      FAIL_STATUS=$STATUS
      fail outcome_unknown "$UNKNOWN_OUTCOME"
    fi
    return 0
  done
}

# Kinds: whether a call is a read or an act, from the server's own list of this connection's calls, kept with the
# list's revision for the current connection only. Access and the listing itself are reads, exempt from the list.

# kinds_lookup FILE METHOD PATH GENERATION: prints "read REVISION", "act REVISION", "both REVISION" (a read and an act
# both match the path, such as /api/v1/problems/export and /api/v1/problems/{id}), none (the list does not hold the
# call) or stale (no usable list). Kind and revision come from one read of the file.
kinds_lookup() {
  [ -f "$1" ] || {
    printf 'stale'
    return 0
  }
  awk -v m="$2" -v p="$3" -v gen="$4" -v t="$(now)" -v maxage="$KINDS_MAX_AGE" -v magic="$KINDS_MAGIC" \
    -v fmt="$KINDS_FORMAT" -v tre="$TEMPLATE_RE" '
function match_t(tpl, pth,   tn, sn, ta, sa, i, j, rest) {
  tn = split(tpl, ta, "/"); sn = split(pth, sa, "/")
  for (i = 1; i <= tn; i++) {
    if (ta[i] ~ /^[{][^}]*:path[}]$/) {
      if (i != tn || sn < i) return 0
      rest = ""
      for (j = i; j <= sn; j++) rest = rest sa[j]
      return rest != ""
    }
    if (i > sn) return 0
    if (ta[i] ~ /^[{][^}]*[}]$/) { if (sa[i] == "") return 0 }
    else if (ta[i] != sa[i]) return 0
  }
  return tn == sn
}
NR == 1 {
  if ($1 != magic || $2 != fmt || gen == "" || $3 != gen || t - $4 > maxage || $5 !~ /^[A-Za-z0-9._-]+$/ || length($5) > 128) { bad = 1; exit }
  rev = $5
  next
}
NF == 3 && $1 == m && $2 ~ tre && ($3 == "read" || $3 == "act") {
  if (match_t($2, p)) { if ($3 == "act") act = 1; else read = 1 }
}
END {
  if (bad || NR == 0) printf "stale"
  else if (act && read) printf "both %s", rev
  else if (act) printf "act %s", rev
  else if (read) printf "read %s", rev
  else printf "none"
}' "$1"
}

# kinds_build ANSWERFILE GENERATION: the list of a listing answer, in the kinds format, into a private temp file
# (LISTF). Returns 1 when the answer is not a list with a valid revision.
kinds_build() {
  tmpdir
  scan="$TMPD/scan.$(rand 6)"
  json_scan kinds "$1" >"$scan" 2>/dev/null || return 1
  grep -qx L "$scan" || return 1
  rev=$(sed -n 's/^R //p' "$scan" | head -n 1)
  revision_ok "$rev" || return 1
  LISTF="$TMPD/list.$(rand 6)"
  {
    printf '%s %s %s %s %s\n' "$KINDS_MAGIC" "$KINDS_FORMAT" "$2" "$(now)" "$rev"
    awk -v tre="$TEMPLATE_RE" 'NF == 3 && $1 ~ /^[A-Z][A-Z][A-Z][A-Z]?[A-Z]?[A-Z]?[A-Z]?$/ && $2 ~ tre' "$scan"
  } >"$LISTF" 2>/dev/null || return 1
}

# kinds_store GENERATION: keeps LISTF for the connection it was fetched under. Only a cache: a failure changes nothing.
kinds_store() {
  [ "$1" != - ] || return 0
  record_read || return 0
  [ "$R_generation" = "$1" ] || return 0
  t="$TMPD/kinds.$(rand 6)"
  if cp "$LISTF" "$t" 2>/dev/null && mv -f "$t" "$KINDS" 2>/dev/null; then return 0; fi
  rm -f "$t"
}

# kinds_fetch: the server's list, into LISTF and kept for this connection (LISTGEN is the connection it was fetched
# under). Fails closed: when the listing cannot be read, or its answer is not a list, nothing is sent
# (endpoints_unavailable). Errors of the connection itself are passed on as they are.
kinds_fetch() {
  LISTGEN=-
  if record_read && [ -n "$R_generation" ]; then LISTGEN=$R_generation; fi
  kf_kind=$KIND kf_rev=$REVISION kf_ref=$s_ref kf_busy=$s_busy kf_net=$s_net kf_pol=$s_pol
  KIND=read REVISION="" SOFT=1
  if api_send GET "$ISSUER$ENDPOINTS_PATH" ""; then kf_ok=1; else kf_ok=0; fi
  SOFT=0
  KIND=$kf_kind REVISION=$kf_rev s_ref=$kf_ref s_busy=$kf_busy s_net=$kf_net s_pol=$kf_pol
  [ $kf_ok = 1 ] && [ "$STATUS" = 200 ] || fail endpoints_unavailable "$UNAVAILABLE"
  kinds_build "$RESP" "$LISTGEN" || fail endpoints_unavailable "$UNAVAILABLE"
  kinds_store "$LISTGEN"
}

# kind_of METHOD PATH: sets KIND, REVISION and BOTH. A path the server's list does not hold is not sent (bad_path),
# after the list was fetched again in case it changed. A path that a read and an act both match goes as an act first
# (BOTH=1: api_send may send it once more as a read).
kind_of() {
  if [ "$1" = GET ]; then
    case "$2" in "$ACCESS_PATH" | "$ENDPOINTS_PATH")
      KIND=read REVISION=""
      return 0
      ;;
    esac
  fi
  # Without a connection there is no list to read: say so, as the other versions do.
  record_read || fail not_connected "Not connected. Run: $CMD connect"
  [ -n "$R_refreshToken" ] || fail not_connected "Not connected. Run: $CMD connect"
  k=$(kinds_lookup "$KINDS" "$1" "$2" "$R_generation")
  if [ "$k" = stale ] || [ "$k" = none ]; then
    kinds_fetch
    k=$(kinds_lookup "$LISTF" "$1" "$2" "$LISTGEN")
  fi
  BOTH=0
  case "$k" in
    "read "* | "act "*) KIND=${k%% *} REVISION=${k#* } ;;
    "both "*) KIND=act REVISION=${k#* } BOTH=1 ;;
    *) fail bad_path "$NOT_LISTED" ;;
  esac
}

cmd_api() {
  method=$1
  api_url "${2:-}"
  bodyfile=""
  wantbody=0
  case "$method" in
    POST) wantbody=1 ;;
  esac
  if [ $wantbody = 1 ]; then
    secure_dir
    tmpdir
    bodyfile="$TMPD/body.$(rand 6)"
    if [ -n "$JSON_FILE" ]; then
      cat -- "$JSON_FILE" >"$bodyfile" 2>/dev/null || fail bad_body "Cannot read $JSON_FILE."
    else
      if [ "$HAVE_JSON" = 1 ]; then printf '%s' "$JSON_BODY" >"$bodyfile"; else printf '{}' >"$bodyfile"; fi
    fi
    # Exactly what JSON.parse takes, no more (json_scan), checked before anything is sent.
    [ "$(json_scan valid "$bodyfile")" = 1 ] || fail bad_body "The body is not JSON."
  fi
  listing=0
  [ "$method" = GET ] && [ "$APATH" = "$ENDPOINTS_PATH" ] && [ "$HASQ" = 0 ] && listing=1
  lgen=-
  if [ $listing = 1 ] && record_read && [ -n "$R_generation" ]; then lgen=$R_generation; fi
  kind_of "$method" "$APATH"
  CALL_PATH=$APATH
  api_send "$method" "$URL" "$bodyfile"
  case "$STATUS" in
    2??)
      # Any strict JSON value is JSON, null, false, numbers and strings included, as in the other versions.
      isjson=$RESP_JSON
      if [ $listing = 1 ] && [ $isjson = 1 ] && kinds_build "$RESP" "$lgen"; then kinds_store "$lgen"; fi
      if [ $isjson = 1 ]; then data=$(tr -d '\r\n' <"$RESP"); else data=$(json_string "$RESP"); fi
      if [ $isjson = 1 ] && [ "$(json_scan failed "$RESP")" = 1 ]; then
        printf '{"error":"failed","message":"%s","status":%s,"data":%s}\n' "$(esc "$method ${2:-} answered that it failed.")" "$STATUS" "$data"
        exit 1
      fi
      printf '{"status":%s,"data":%s}\n' "$STATUS" "$data"
      return 0
      ;;
  esac
  code=$(json_scan top "$RESP" error)
  # A connection the person did not allow to ask for instance access: it needs a new approval to get it.
  if [ "$STATUS" = 403 ] && [ "$code" = not_allowed ]; then
    FAIL_STATUS=$STATUS
    fail insufficient_scope "$NO_ACCESS_SCOPE"
  fi
  # The server's own refusals for agents carry a code and a message (in the top object): passed on as they are. A
  # message with escapes left in it is left to http_fail.
  message=$(json_scan top "$RESP" message)
  case "$message" in *\\*) message="" ;; esac
  case "$code" in "" | *[!a-z_]*) ;; *)
    if [ -n "$message" ] && [ ${#code} -le 40 ]; then
      FAIL_STATUS=$STATUS
      fail "$code" "$message"
    fi
    ;;
  esac
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
    if oauth "$REVOKE_PATH" "token=$t" "token_type_hint=refresh_token" && [ "$STATUS" = 200 ]; then :; else left="$left $t"; fi
  done
  if [ -n "$left" ]; then
    R_refreshToken='' R_accessToken='' R_accessExpiresAt=0 R_toRevoke=$(printf '%s' "$left" | sed 's/^ *//')
    record_write
    fail disconnect_failed "$PRODUCT did not confirm the disconnect. Run it again, or end the connection in $PRODUCT."
  fi
  record_remove
  printf '{"status":"disconnected"}\n'
}

COMMAND=${1:-help}
[ $# -gt 0 ] && shift
URL_OPTION="" REPLACE=0 WAIT=0 JSON_BODY="" HAVE_JSON=0 JSON_FILE="" ARG="" HAVEARG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL_OPTION=${2:-} && shift ;;
    --replace) REPLACE=1 ;;
    --wait) WAIT=1 ;;
    --json) JSON_BODY=${2:-} HAVE_JSON=1 && shift ;;
    --json-file) JSON_FILE=${2:-} && shift ;;
    *) [ $HAVEARG = 0 ] && ARG=$1 && HAVEARG=1 ;;
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
  access) cmd_api GET "$ACCESS_PATH" ;;
  endpoints)
    if [ $HAVEARG = 0 ]; then
      cmd_api GET "$ENDPOINTS_PATH"
    else
      case "$ARG" in "" | *[!a-z_]*) fail bad_path "Give an area name, for example: read" ;; esac
      cmd_api GET "$ENDPOINTS_PATH?area=$ARG"
    fi
    ;;
  get) cmd_api GET "$ARG" ;;
  post) cmd_api POST "$ARG" ;;
  disconnect) cmd_disconnect ;;
  *) fail unknown_command "Unknown command \"$COMMAND\". Run: $CMD help" ;;
esac
