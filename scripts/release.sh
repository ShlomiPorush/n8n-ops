#!/usr/bin/env bash
# Create a versioned release and publish the container images. Does not deploy anything.
# Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--dry-run]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

REGISTRY="ghcr.io/shlomiporush"
IMAGES=(server:n8n-ops worker:n8n-ops-worker)
TARGET=""
BUMP=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--dry-run]

  --target ghcr   Required. Publish images to ghcr.io/shlomiporush.
  --bump KIND     Required. Semantic version part to increase.
  --dry-run       Check everything and print the plan without changing anything.

Steps: preflight (clean main in sync with origin, release notes present, version unused),
full scripts/verify.sh, version and changelog update, release commit, annotated tag,
image build and push, then push of the commit and tag. Deployment is a separate, manual step.
EOF
}

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

git_() { git -C "$REPO_ROOT" "$@"; }

current_version() {
  sed -nE 's/^  "version": "([0-9]+\.[0-9]+\.[0-9]+)",$/\1/p' "$REPO_ROOT/package.json" | head -1
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

preflight() {
  info "Preflight"
  require_docker
  [ "$(git_ rev-parse --abbrev-ref HEAD)" = main ] || die "releases are made from main"
  [ -z "$(git_ status --porcelain)" ] || die "the working tree is not clean"
  git_ fetch --quiet --tags origin main
  [ "$(git_ rev-parse HEAD)" = "$(git_ rev-parse origin/main)" ] || die "main is not in sync with origin/main"
  [ -n "$(unreleased_notes)" ] || die "CHANGELOG.md has no entries under [Unreleased]"
  local current
  current="$(current_version)"
  [ -n "$current" ] || die "cannot read the version from package.json"
  VERSION="$(next_version "$current")"
  TAG="v$VERSION"
  git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
  local pair
  for pair in "${IMAGES[@]}"; do
    if docker manifest inspect "$REGISTRY/${pair#*:}:$VERSION" >/dev/null 2>&1; then
      die "$REGISTRY/${pair#*:}:$VERSION is already published"
    fi
  done
  echo "    $current -> $VERSION ($TAG)"
}

main() {
  preflight
  if [ $DRY_RUN -eq 1 ]; then
    info "Dry run. Release notes for $TAG:"
    unreleased_notes | sed 's/^/    /'
    info "Would run scripts/verify.sh, commit package.json and CHANGELOG.md, tag $TAG, and push:"
    local pair
    for pair in "${IMAGES[@]}"; do
      echo "    $REGISTRY/${pair#*:}:$VERSION and :latest"
    done
    return 0
  fi

  info "Full verification"
  "$REPO_ROOT/scripts/verify.sh"

  info "Updating version and changelog"
  sed -i -E "0,/^  \"version\": \"[0-9.]+\",$/s//  \"version\": \"$VERSION\",/" "$REPO_ROOT/package.json"
  sed -i "s/^## \[Unreleased\]$/## [Unreleased]\n\n## [$VERSION] - $(date -u +%Y-%m-%d)/" "$REPO_ROOT/CHANGELOG.md"
  git_ add package.json CHANGELOG.md
  git_ commit --quiet -m "Release $TAG"
  git_ tag -a "$TAG" -m "$TAG"

  local pair app name
  for pair in "${IMAGES[@]}"; do
    app="${pair%%:*}" name="${pair#*:}"
    info "Building $REGISTRY/$name:$VERSION"
    docker build -f "$REPO_ROOT/docker/$app.Dockerfile" --build-arg "VERSION=$VERSION" \
      -t "$REGISTRY/$name:$VERSION" -t "$REGISTRY/$name:latest" "$REPO_ROOT" || die "image build failed"
  done
  for pair in "${IMAGES[@]}"; do
    name="${pair#*:}"
    docker push --quiet "$REGISTRY/$name:$VERSION" ||
      die "push failed (log in with: docker login ghcr.io). The release commit and $TAG exist only locally."
    docker push --quiet "$REGISTRY/$name:latest"
  done

  git_ push --quiet origin main
  git_ push --quiet origin "refs/tags/$TAG"
  info "Released $TAG. Deploying is a separate step."
}

main
