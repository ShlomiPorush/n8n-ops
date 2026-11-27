#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

REGISTRY="ghcr.io/shlomiporush"
SOURCE_URL="https://github.com/ShlomiPorush/n8n-ops"
IMAGES=(server:n8n-ops worker:n8n-ops-worker)
MIGRATIONS="apps/server/drizzle"
JOURNAL="$MIGRATIONS/meta/_journal.json"
DOWNTIME_NOTE="- **Needs downtime.**"
DOWNTIME_MIGRATION="-- rollout: downtime"
TARGET=""
BUMP=""
EXPECT_SHA=""
SKIP_VERIFY=0
DRY_RUN=0
RESUME=0
VERSION=""
TAG=""

usage() {
  cat <<'EOF'
Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--skip-verify --expect-sha SHA] [--dry-run]

  --target ghcr     Required. Publish images to ghcr.io/shlomiporush.
  --bump KIND       Required. Semantic version part to increase.
  --expect-sha SHA  Refuse unless main is exactly this commit (the one the workflow verified).
  --skip-verify     Do not run scripts/verify.sh. Only with --expect-sha.
  --dry-run         Check everything and print the plan without changing anything.

Steps: preflight (clean main in sync with origin, release notes present, version unused, released
migrations unchanged, a migration that needs downtime noted under Unreleased), full
scripts/verify.sh, version and changelog update, release commit and tag pushed together, both images
built from the tag and pushed, then :latest, then the GitHub Release from the CHANGELOG section.
When the newest tag has no GitHub Release yet, an earlier run stopped halfway: this run finishes that
version instead of starting a new one, reusing what is already published and refusing anything that
was not built from the tag. Needs docker with buildx, git and gh (logged in to GitHub and GHCR).
EOF
}

git_() { git -C "$REPO_ROOT" "$@"; }

version_in() {
  local text
  text="$(cat)"
  [[ "$text" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$text"
  return 0
}

next_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  case "$BUMP" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

unreleased_notes() {
  awk '/^## \[Unreleased\]/ { on = 1; next } /^## \[/ { on = 0 } on && NF' "$REPO_ROOT/CHANGELOG.md"
}

release_notes() {
  local version="$1" text count notes
  text="$(cat)"
  count="$(grep -cE "^## \[${version//./\\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" <<<"$text" || true)"
  [ "$count" = 1 ] || die "CHANGELOG.md must have exactly one dated section for $version (found $count)"
  notes="$(awk -v head="## [$version] - " '
    index($0, head) == 1 { on = 1; next }
    on && /^## / { exit }
    on { lines[++n] = $0 }
    END {
      s = 1; while (s <= n && lines[s] ~ /^[[:space:]]*$/) s++
      e = n; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
      for (i = s; i <= e; i++) print lines[i]
    }' <<<"$text")"
  grep -qvE '^[[:space:]]*(#.*)?$' <<<"$notes" || die "the CHANGELOG.md section for $version has no entries"
  printf '%s\n' "$notes"
}

has_downtime_note() {
  awk -v note="$DOWNTIME_NOTE" 'index($0, note) == 1 { found = 1 } END { exit !found }'
}

rollout_from() {
  local version="$1" text found
  text="$(cat)"
  found="$(awk -v note="$DOWNTIME_NOTE" '
    /^## \[[0-9]+\.[0-9]+\.[0-9]+\] - [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ {
      section = substr($2, 2, length($2) - 2)
      next
    }
    /^## / { section = ""; next }
    section != "" && found == "" && index($0, note) == 1 { found = section }
    END { print found }' <<<"$text")"
  printf '%s\n' "${found:-$version}"
}

release_state() {
  local out
  if out="$(gh release view "$1" --json tagName 2>&1)"; then
    echo present
  elif grep -qi "release not found" <<<"$out"; then
    echo missing
  else
    die "cannot read the GitHub Release $1: $out"
  fi
}

image_state() {
  local ref="$1" revision="$2" out
  if ! out="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>&1)"; then
    if grep -qiE "not found|manifest unknown" <<<"$out"; then
      echo missing
      return
    fi
    die "cannot read $ref from the registry: $out"
  fi
  if grep -qF "\"org.opencontainers.image.revision\":\"$revision\"" <<<"$(tr -d '[:space:]' <<<"$out")"; then
    echo match
  else
    echo other
  fi
}

image_carries() {
  local ref="$1" out label
  shift
  out="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>&1)" ||
    die "cannot read $ref from the registry: $out"
  out="$(tr -d '[:space:]' <<<"$out")"
  for label in "$@"; do
    grep -qF "\"${label%%=*}\":\"${label#*=}\"" <<<"$out" || return 1
  done
}

newest_tag() {
  git_ tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1
}

journal_at() {
  if git_ cat-file -e "$1:$JOURNAL" 2>/dev/null; then
    git_ show "$1:$JOURNAL"
  else
    echo '{}'
  fi
}

check_migrations() {
  local newest="$1" added file first downtime=() old new result changed
  added="$(git_ diff --name-only --no-renames --diff-filter=A "$newest" HEAD -- "$MIGRATIONS/*.sql")"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    first="$(git_ show "HEAD:$file" | sed -n 1p)"
    if [ "$first" = "$DOWNTIME_MIGRATION" ]; then
      downtime+=("$file")
    fi
  done <<<"$added"
  if [ ${#downtime[@]} -gt 0 ] && ! has_downtime_note <<<"$(unreleased_notes)"; then
    die "${downtime[*]} starts with '$DOWNTIME_MIGRATION', so this release needs downtime, but no line under [Unreleased] in CHANGELOG.md starts with '$DOWNTIME_NOTE'. Add one that says why and what an update needs."
  fi

  old="$(journal_at "$newest")"
  new="$(journal_at HEAD)"
  result="$(jq -rn --argjson old "$old" --argjson new "$new" '
    ($old.entries // []) as $o | ($new.entries // []) as $n
    | if $n[0:($o | length)] != $o then "changed"
      else ([range(1; $n | length) | select($n[.].when <= $n[. - 1].when) | $n[.].tag] | join(", ")) as $late
      | if $late == "" then "ok" else "late " + $late end
      end')" || die "cannot read $JOURNAL at $newest or at HEAD"
  case "$result" in
    ok) ;;
    changed) die "$JOURNAL changes or removes entries released in $newest. Released migrations stay as they are; add a new migration instead." ;;
    "late "*) die "each entry in $JOURNAL must have a later \"when\" than the one before it, but ${result#late } does not" ;;
    *) die "cannot read $JOURNAL at $newest or at HEAD" ;;
  esac

  changed="$(git_ diff --name-only --no-renames --diff-filter=DMT "$newest" HEAD -- "$MIGRATIONS/*.sql")"
  [ -z "$changed" ] || die "migrations released in $newest were changed, moved or removed: ${changed//$'\n'/, }. Released migrations stay as they are; add a new migration instead."
}

preflight() {
  info "Preflight"
  require_docker
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is required"
  [ "$(git_ rev-parse --abbrev-ref HEAD)" = main ] || die "releases are made from main"
  [ -z "$(git_ status --porcelain)" ] || die "the working tree is not clean"
  git_ fetch --quiet --tags origin main
  local head
  head="$(git_ rev-parse HEAD)"
  [ "$head" = "$(git_ rev-parse origin/main)" ] || die "main is not in sync with origin/main"
  if [ -n "$EXPECT_SHA" ] && [ "$head" != "$EXPECT_SHA" ]; then
    die "main is at $head, not at the verified $EXPECT_SHA: something was pushed meanwhile. Start a new release run."
  fi

  local newest state
  newest="$(newest_tag)"
  if [ -n "$newest" ]; then
    state="$(release_state "$newest")"
    if [ "$state" = missing ]; then
      RESUME=1 TAG="$newest" VERSION="${newest#v}"
      git_ merge-base --is-ancestor "$TAG" HEAD || die "$TAG is not on main"
      [ "$(git_ show "$TAG:VERSION" | version_in)" = "$VERSION" ] || die "the version at $TAG is not $VERSION"
      echo "    $TAG was not finished: this run finishes it and ignores --bump $BUMP. Run again for the next version."
      return
    fi
  fi

  [ -n "$(unreleased_notes)" ] || die "CHANGELOG.md has no entries under [Unreleased]"
  [ -z "$newest" ] || check_migrations "$newest"
  local current pair
  current="$(version_in <"$REPO_ROOT/VERSION")"
  [ -n "$current" ] || die "VERSION must hold one version, such as 1.2.3, and nothing else"
  VERSION="$(next_version "$current")"
  TAG="v$VERSION"
  git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
  for pair in "${IMAGES[@]}"; do
    state="$(image_state "$REGISTRY/${pair#*:}:$VERSION" none)"
    [ "$state" = missing ] || die "$REGISTRY/${pair#*:}:$VERSION is already published"
  done
  echo "    $current -> $VERSION ($TAG)"
}

create_tag() {
  if [ $SKIP_VERIFY -eq 0 ]; then
    info "Full verification"
    "$REPO_ROOT/scripts/verify.sh"
  fi
  info "Updating version and changelog"
  printf '%s\n' "$VERSION" >"$REPO_ROOT/VERSION"
  sed -i "s/^## \[Unreleased\]$/## [Unreleased]\n\n## [$VERSION] - $(date -u +%Y-%m-%d)/" "$REPO_ROOT/CHANGELOG.md"
  release_notes "$VERSION" <"$REPO_ROOT/CHANGELOG.md" >/dev/null
  git_ add VERSION CHANGELOG.md
  git_ commit --quiet -m "Release $TAG"
  git_ tag -a "$TAG" -m "$TAG"
  info "Pushing the release commit and $TAG"
  git_ push --quiet --atomic origin HEAD:refs/heads/main "refs/tags/$TAG" ||
    die "pushing the release commit and $TAG failed, so nothing was published. Run the release again."
}

publish_images() {
  local revision src pair app name ref state compose_sha from rollout labels label
  revision="$(git_ rev-parse "$TAG^{commit}")"
  src="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: the path is fixed
  trap "rm -rf '$src'" EXIT
  git_ archive "$TAG" | tar -x -C "$src"
  compose_sha="$(sha256sum "$src/docker-compose.yml" | cut -d ' ' -f 1)" || die "$TAG has no docker-compose.yml to hash"
  from="$(git_ show "$TAG:CHANGELOG.md" | rollout_from "$VERSION")"
  for pair in "${IMAGES[@]}"; do
    app="${pair%%:*}" name="${pair#*:}" ref="$REGISTRY/${pair#*:}:$VERSION"
    rollout=()
    if [ "$app" = server ]; then
      rollout=("n8n-ops.compose-sha256=$compose_sha" "n8n-ops.rollout-from=$from")
    fi
    labels=()
    for label in "${rollout[@]}"; do
      labels+=(--label "$label")
    done
    state="$(image_state "$ref" "$revision")"
    case "$state" in
      match)
        if [ ${#rollout[@]} -gt 0 ] && ! image_carries "$ref" "${rollout[@]}"; then
          die "$ref was built from $TAG but carries other rollout labels; it is left as it is"
        fi
        echo "    $ref is already published from $TAG"
        ;;
      other) die "$ref exists but was not built from $TAG; it is left as it is" ;;
      missing)
        info "Building and pushing $ref"
        docker buildx build --push --provenance=mode=max --sbom=true \
          -f "$src/docker/$app.Dockerfile" \
          --label "org.opencontainers.image.revision=$revision" \
          --label "org.opencontainers.image.source=$SOURCE_URL" \
          --label "org.opencontainers.image.version=$VERSION" \
          "${labels[@]}" \
          -t "$ref" "$src" || die "building or pushing $ref failed. Run the release again to finish $TAG."
        ;;
    esac
  done
  for pair in "${IMAGES[@]}"; do
    ref="$REGISTRY/${pair#*:}:$VERSION"
    state="$(image_state "$ref" "$revision")"
    [ "$state" = match ] || die "$ref is not the image built from $TAG"
  done
  for pair in "${IMAGES[@]}"; do
    name="${pair#*:}"
    info "Pointing $REGISTRY/$name:latest at $VERSION"
    docker buildx imagetools create --tag "$REGISTRY/$name:latest" "$REGISTRY/$name:$VERSION" ||
      die "moving $REGISTRY/$name:latest failed. Run the release again to finish $TAG."
  done
}

publish_release() {
  local notes state
  notes="$(mktemp)"
  git_ show "$TAG:CHANGELOG.md" | release_notes "$VERSION" >"$notes"
  info "Creating the GitHub Release $TAG"
  if ! gh release create "$TAG" --verify-tag --title "n8n-ops $VERSION" --notes-file "$notes"; then
    state="$(release_state "$TAG")"
    [ "$state" = present ] || die "creating the GitHub Release $TAG failed. Run the release again to finish it."
    echo "    the GitHub Release $TAG exists"
  fi
  rm -f "$notes"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --target)
        TARGET="${2:-}"
        shift
        ;;
      --bump)
        BUMP="${2:-}"
        shift
        ;;
      --expect-sha)
        EXPECT_SHA="${2:-}"
        shift
        ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      --dry-run) DRY_RUN=1 ;;
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

  [ "$TARGET" = ghcr ] || die "an explicit target is required: --target ghcr"
  [[ "$BUMP" =~ ^(patch|minor|major)$ ]] || die "--bump must be patch, minor or major"
  [ -z "$EXPECT_SHA" ] || [[ "$EXPECT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--expect-sha must be a full commit SHA"
  [ $SKIP_VERIFY -eq 0 ] || [ -n "$EXPECT_SHA" ] || die "--skip-verify needs --expect-sha of the verified commit"

  preflight
  if [ $DRY_RUN -eq 1 ]; then
    if [ $RESUME -eq 1 ]; then
      info "Dry run. Would finish $TAG: the missing images, :latest and the GitHub Release."
    else
      info "Dry run. Release notes for $TAG:"
      unreleased_notes | sed 's/^/    /'
      info "Would commit VERSION and CHANGELOG.md, push them with $TAG, then publish:"
    fi
    local pair
    for pair in "${IMAGES[@]}"; do
      echo "    $REGISTRY/${pair#*:}:$VERSION and :latest"
    done
    return 0
  fi

  [ $RESUME -eq 1 ] || create_tag
  publish_images
  publish_release
  info "Released $TAG. Deploying is a separate step."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
