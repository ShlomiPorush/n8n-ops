#!/usr/bin/env bash
# Tests for scripts/release.sh: real git against a local bare remote, with docker and gh replaced by
# stand-ins that keep the registry and the GitHub Releases in files and fail on request. Covers a
# release, each way a run can stop halfway, and the run after it. Run by scripts/verify.sh (guards).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/n8n-ops-release-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
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
# Registry stand-in: one file per image tag, holding the commit it was built from.
key() { printf '%s' "$1" | tr '/:' '__'; }
echo "docker $*" >>"$STATE/calls"
[ "$1" = info ] && exit 0
[ "$1" = buildx ] || { echo "unexpected docker $*" >&2; exit 2; }
shift
if [ "$1 $2" = "imagetools inspect" ]; then
  [ -n "${MOCK_REGISTRY_DOWN:-}" ] && { echo "ERROR: unauthorized: authentication required" >&2; exit 1; }
  f="$STATE/images/$(key "$3")"
  [ -f "$f" ] || { echo "ERROR: $3: not found" >&2; exit 1; }
  # Indented, as docker prints it.
  printf '{\n  "architecture": "amd64",\n  "config": {\n    "Labels": {\n      "org.opencontainers.image.revision": "%s"\n    }\n  }\n}\n' "$(cat "$f")"
  exit 0
fi
if [ "$1 $2" = "imagetools create" ]; then
  [ -f "$STATE/images/$(key "$5")" ] || exit 1
  cp "$STATE/images/$(key "$5")" "$STATE/images/$(key "$4")"
  exit 0
fi
if [ "$1" = build ]; then
  rev="" ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) case "$2" in org.opencontainers.image.revision=*) rev="${2#*=}" ;; esac; shift ;;
      -t) ref="$2"; shift ;;
    esac
    shift
  done
  case "$ref" in *"${MOCK_FAIL_BUILD:-no-such-image}"*) echo "push failed" >&2; exit 1 ;; esac
  printf '%s' "$rev" >"$STATE/images/$(key "$ref")"
  exit 0
fi
echo "unexpected docker buildx $*" >&2
exit 2
EOF
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# GitHub Releases stand-in: one file per release, holding its title and notes.
echo "gh $*" >>"$STATE/calls"
[ "$1" = release ] || exit 2
case "$2" in
  view)
    [ -n "${MOCK_GH_DOWN:-}" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    [ -f "$STATE/releases/$3" ] || { echo "release not found" >&2; exit 1; }
    echo '{"tagName":"'"$3"'"}'
    exit 0
    ;;
  create)
    tag="$3" title="" notes=""
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) title="$2"; shift ;;
        --notes-file) notes="$2"; shift ;;
      esac
      shift
    done
    [ "${MOCK_CREATE:-}" = fail ] && { echo "HTTP 500" >&2; exit 1; }
    { echo "$title"; cat "$notes"; } >"$STATE/releases/$tag"
    [ "${MOCK_CREATE:-}" = lost ] && { echo "connection reset" >&2; exit 1; }
    exit 0
    ;;
esac
exit 2
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gh"

# --- sandbox ---------------------------------------------------------------------------------

# A fresh origin with one commit on main and a fresh registry and Releases; prints nothing.
sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/images" "$WORK/case/releases"
  export STATE="$WORK/case"
  git init --quiet --bare --initial-branch=main "$WORK/case/origin.git"
  local seed="$WORK/case/seed"
  git init --quiet --initial-branch=main "$seed"
  mkdir -p "$seed/scripts/lib" "$seed/docker"
  cp "$REPO/scripts/release.sh" "$seed/scripts/"
  cp "$REPO/scripts/lib/common.sh" "$seed/scripts/lib/"
  : >"$seed/docker/server.Dockerfile"
  : >"$seed/docker/worker.Dockerfile"
  printf '{\n  "name": "n8n-ops",\n  "version": "0.0.0",\n  "private": true\n}\n' >"$seed/package.json"
  printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- The first feature.\n' >"$seed/CHANGELOG.md"
  git -C "$seed" add -A
  git -C "$seed" commit --quiet -m "Initial"
  git -C "$seed" remote add origin "$WORK/case/origin.git"
  git -C "$seed" push --quiet origin main
}

# A new checkout of origin's main, as each workflow run makes; prints its path.
checkout() {
  local dir
  dir="$(mktemp -d "$WORK/case/run.XXXX")"
  git clone --quiet "$WORK/case/origin.git" "$dir/repo"
  echo "$dir/repo"
}

origin_head() { git -C "$WORK/case/origin.git" rev-parse main; }

# Runs a release in a new checkout, verified at origin's current main unless EXPECT is set.
release() {
  local dir
  dir="$(checkout)"
  (cd "$dir" && PATH="$WORK/bin:$PATH" bash scripts/release.sh --target ghcr --bump "${BUMP:-minor}" \
    --skip-verify --expect-sha "${EXPECT:-$(origin_head)}") >"$WORK/case/out" 2>&1
}

has_tag() { git -C "$WORK/case/origin.git" rev-parse -q --verify "refs/tags/$1" >/dev/null; }
image_rev() { cat "$STATE/images/ghcr.io_shlomiporush_$1" 2>/dev/null; }
tag_rev() { git -C "$WORK/case/origin.git" rev-parse "$1^{commit}"; }
has_release() { [ -f "$STATE/releases/$1" ]; }
lacks_tag() { ! has_tag "$1"; }
lacks_release() { ! has_release "$1"; }
nothing_built() { ! grep -q "buildx build" "$STATE/calls"; }
said() { grep -q "$1" "$WORK/case/out"; }
complete() {
  local rev
  rev="$(tag_rev "v$1")"
  [ "$(image_rev "n8n-ops_$1")" = "$rev" ] && [ "$(image_rev "n8n-ops-worker_$1")" = "$rev" ] &&
    [ "$(image_rev n8n-ops_latest)" = "$rev" ] && [ "$(image_rev n8n-ops-worker_latest)" = "$rev" ] &&
    has_release "v$1"
}

# --- cases -----------------------------------------------------------------------------------

sandbox
release
check "a release succeeds" [ $? -eq 0 ]
check "it releases 0.1.0 from 0.0.0 with --bump minor" complete 0.1.0
check "origin main is the release commit" [ "$(git -C "$WORK/case/origin.git" log -1 --format=%s main)" = "Release v0.1.0" ]
check "the tag is on the release commit" [ "$(tag_rev v0.1.0)" = "$(origin_head)" ]
check "package.json says 0.1.0" grep -q '"version": "0.1.0"' <(git -C "$WORK/case/origin.git" show main:package.json)
check "the CHANGELOG keeps an empty Unreleased above the dated section" \
  grep -qzP '## \[Unreleased\]\n\n## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}\n' <(git -C "$WORK/case/origin.git" show main:CHANGELOG.md)
check "the GitHub Release has the title and the section's notes" \
  [ "$(cat "$STATE/releases/v0.1.0")" = "$(printf 'n8n-ops 0.1.0\n### Added\n\n- The first feature.')" ]
dir="$(checkout)"
sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n\n- A fix./' "$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Fix" && git -C "$dir" push --quiet origin main
BUMP="patch" release
check "the next run releases 0.1.1 with --bump patch" complete 0.1.1
check "0.1.1's notes hold only its own entries" [ "$(sed -n '2,$p' "$STATE/releases/v0.1.1")" = "$(printf '### Fixed\n\n- A fix.')" ]

sandbox
stale="$(origin_head)"
dir="$(checkout)"
echo change >"$dir/file" && git -C "$dir" add file && git -C "$dir" commit --quiet -m "Merged meanwhile" && git -C "$dir" push --quiet origin main
EXPECT="$stale" release
check "main moved after verification: the run stops" [ $? -ne 0 ]
check "  and says why" said "something was pushed meanwhile"
check "  and publishes nothing" [ ! -e "$STATE/images/ghcr.io_shlomiporush_n8n-ops_0.1.0" ]
check "  and pushes no tag" lacks_tag v0.1.0

sandbox
printf '#!/bin/sh\nexit 1\n' >"$WORK/case/origin.git/hooks/pre-receive" && chmod +x "$WORK/case/origin.git/hooks/pre-receive"
release
check "origin refuses the push: the run stops" [ $? -ne 0 ]
check "  before any image is built" nothing_built
rm "$WORK/case/origin.git/hooks/pre-receive"
release
check "  and the next run releases 0.1.0 in full" complete 0.1.0

sandbox
MOCK_FAIL_BUILD=n8n-ops-worker release
check "the second image fails: the run stops" [ $? -ne 0 ]
check "  with the tag on origin" has_tag v0.1.0
check "  the first image published" [ "$(image_rev n8n-ops_0.1.0)" = "$(tag_rev v0.1.0)" ]
check "  and :latest not moved" [ ! -e "$STATE/images/ghcr.io_shlomiporush_n8n-ops_latest" ]
check "  and no GitHub Release" lacks_release v0.1.0
BUMP="major" release
check "the next run finishes 0.1.0 and ignores the bump" complete 0.1.0
check "  and says so" said "v0.1.0 was not finished"
check "  without building the first image again" [ "$(grep -c "buildx build.*n8n-ops:0.1.0" "$STATE/calls")" = 1 ]
check "  and starts no other version" lacks_tag v1.0.0

sandbox
MOCK_FAIL_BUILD=n8n-ops-worker release
printf other >"$STATE/images/ghcr.io_shlomiporush_n8n-ops_0.1.0"
release
check "an image of this version from another commit stops the run" [ $? -ne 0 ]
check "  with a clear reason" said "exists but was not built from v0.1.0"
check "  and is left as it is" [ "$(image_rev n8n-ops_0.1.0)" = other ]

sandbox
MOCK_CREATE=fail release
check "the GitHub Release fails: the run stops" [ $? -ne 0 ]
check "  after both images and :latest" [ "$(image_rev n8n-ops-worker_latest)" = "$(tag_rev v0.1.0)" ]
release
check "  and the next run creates the Release" complete 0.1.0
check "  without pushing the images again" [ "$(grep -c "buildx build" "$STATE/calls")" = 2 ]

sandbox
MOCK_CREATE=lost release
check "a Release created with its answer lost counts as created" [ $? -eq 0 ]
check "  and the version is complete" complete 0.1.0

sandbox
printf other >"$STATE/images/ghcr.io_shlomiporush_n8n-ops_0.1.0"
release
check "the next version is already in the registry: the run stops" [ $? -ne 0 ]
check "  before tagging" lacks_tag v0.1.0

sandbox
MOCK_REGISTRY_DOWN=1 release
check "a registry that cannot be read stops the run" [ $? -ne 0 ]
check "  and is not taken for a free version" lacks_tag v0.1.0

sandbox
MOCK_FAIL_BUILD=n8n-ops-worker release
MOCK_GH_DOWN=1 release
check "GitHub that cannot be read stops the run" [ $? -ne 0 ]
check "  and starts no new version" lacks_tag v0.2.0

sandbox
dir="$(checkout)"
printf '# Changelog\n\n## [Unreleased]\n' >"$dir/CHANGELOG.md"
git -C "$dir" commit --quiet -am "Empty" && git -C "$dir" push --quiet origin main
release
check "an empty Unreleased section stops the run" [ $? -ne 0 ]
check "  with a clear reason" said "no entries under \[Unreleased\]"

# release_notes on its own.
# shellcheck source=scripts/release.sh
source "$REPO/scripts/release.sh"
set +e
notes() { (release_notes "$1" <<<"$2") 2>&1; }
check "notes: the one section, without its heading" \
  [ "$(notes 1.0.0 "$(printf '## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\n### Added\n\n- A.\n\n## [0.9.0] - 2026-01-01\n\n- B.\n')")" = "$(printf '### Added\n\n- A.')" ]
check "notes: a missing section fails" grep -q "found 0" <(notes 1.0.0 "## [0.9.0] - 2026-01-01")
check "notes: a section twice fails" grep -q "found 2" <(notes 1.0.0 "$(printf '## [1.0.0] - 2026-01-02\n- A.\n## [1.0.0] - 2026-01-03\n- B.\n')")
check "notes: a section of headings only fails" grep -q "has no entries" <(notes 1.0.0 "$(printf '## [1.0.0] - 2026-01-02\n\n### Added\n\n')")
check "notes: 1.0.0 does not match 1.0.01" grep -q "found 0" <(notes 1.0.0 "## [1.0.01] - 2026-01-02")

echo "release.sh: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
