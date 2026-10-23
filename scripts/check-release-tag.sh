#!/usr/bin/env bash
# check-release-tag.sh — the release workflow's first gate.
#
# Passes only when TAG:
#   1. has the form vMAJOR.MINOR.PATCH (optionally -prerelease),
#   2. exists as refs/tags/TAG and is an annotated tag
#      (`git cat-file -t refs/tags/TAG` is "tag", not "commit"),
#   3. equals v<package.json version> (package.yaml version is held equal by
#      scripts/check-manifest-sync.mjs, which this script also runs), and
#   4. points at the checked-out commit (HEAD).
#
# In GitHub Actions, actions/checkout can store a pushed annotated tag as a
# lightweight ref. The workflow force-fetches refs/tags/TAG from origin before
# calling this script so check 2 sees the real tag object.
#
# Usage: check-release-tag.sh TAG [pack-root]   (default root: this repo)
# Prints the version on stdout. Exit 0 ok · 1 check failed · 2 bad usage.

set -uo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TAG="${1:-}"
ROOT="${2:-$(cd "$SCRIPTS/.." && pwd -P)}"

fail() { echo "check-release-tag: $*" >&2; exit 1; }

if [[ -z "$TAG" ]]; then
  echo "usage: check-release-tag.sh TAG [pack-root]" >&2
  exit 2
fi
TAG="${TAG#refs/tags/}"

[[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
  || fail "tag \"$TAG\" is not vMAJOR.MINOR.PATCH[-prerelease]"

type="$(git -C "$ROOT" cat-file -t "refs/tags/$TAG" 2>/dev/null)" \
  || fail "refs/tags/$TAG does not exist in $ROOT"
[[ "$type" == "tag" ]] \
  || fail "$TAG is a lightweight tag (refs/tags/$TAG is a $type); cut releases with git tag -a"

version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version || ""))' "$ROOT/package.json")" \
  || fail "cannot read package.json version"
[[ "$TAG" == "v$version" ]] \
  || fail "tag $TAG does not match package.json version $version (expected v$version)"

node "$SCRIPTS/check-manifest-sync.mjs" "$ROOT" >/dev/null \
  || fail "package.json and package.yaml disagree (see check-manifest-sync output above)"

tag_commit="$(git -C "$ROOT" rev-parse "refs/tags/$TAG^{commit}")" || fail "cannot resolve $TAG to a commit"
head_commit="$(git -C "$ROOT" rev-parse HEAD)" || fail "cannot resolve HEAD"
[[ "$tag_commit" == "$head_commit" ]] \
  || fail "$TAG points at $tag_commit but the checkout is at $head_commit"

echo "check-release-tag: $TAG is annotated, matches package.json and package.yaml, and points at HEAD" >&2
printf '%s\n' "$version"
