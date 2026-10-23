#!/usr/bin/env bash
# build-tarball.sh — build the marketplace-shaped pack tarball.
#
# The archive is packed with `tar -C <payload> .`, the layout hq-cli's
# marketplace transport expects: package.yaml at the archive root, no
# `package/` wrapper (hq-cli src/commands/pack-install.ts fetchMarketplace,
# src/commands/publish.ts tarballPayload).
#
# The payload is the git-tracked files under PAYLOAD_PATHS, so untracked or
# ignored files in a working tree (for example generated types) never ship,
# and tracked dotfiles such as skills/run-project/.gitignore do. `npm pack`
# drops .gitignore files; scripts/check-npm-contents.mjs checks that this is
# the only difference between the two artifacts.
#
# Writes <out>/hq-pack-core-skills-<version>.tar.gz and <out>/SHA256SUMS
# (`<sha256>  <file name>`, the format `sha256sum -c` reads), then prints the
# tarball path on stdout.
#
# Usage: build-tarball.sh [--out DIR] [pack-root]
#   --out DIR   output directory (default: <pack-root>/dist)
#   pack-root   a git checkout of this repo (default: this script's repo)
# Exit 0 built · 1 build failed · 2 bad usage.

set -euo pipefail

PAYLOAD_PATHS=(package.yaml skills commands.json SOURCE.md core-resident-skills.txt README.md LICENSE)

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
OUT=""
ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "build-tarball: unknown option $1" >&2; exit 2 ;;
    *) ROOT="$1"; shift ;;
  esac
done
ROOT="$(cd "${ROOT:-$SCRIPTS/..}" && pwd -P)"
OUT="${OUT:-$ROOT/dist}"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "build-tarball: $ROOT is not a git checkout; the payload is read from git-tracked files" >&2
  exit 2
fi

version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version || ""))' "$ROOT/package.json")"
if [[ -z "$version" ]]; then
  echo "build-tarball: package.json has no version" >&2
  exit 1
fi

for p in "${PAYLOAD_PATHS[@]}"; do
  if [[ -z "$(git -C "$ROOT" ls-files -- "$p" | head -n 1)" ]]; then
    echo "build-tarball: $p is not tracked in git" >&2
    exit 1
  fi
done

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
payload="$stage/payload"
mkdir -p "$payload"

# Copy tracked files only. `git ls-files -z` keeps names with spaces intact.
while IFS= read -r -d '' f; do
  mkdir -p "$payload/$(dirname "$f")"
  cp -p "$ROOT/$f" "$payload/$f"
done < <(git -C "$ROOT" ls-files -z -- "${PAYLOAD_PATHS[@]}")

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
name="hq-pack-core-skills-$version.tar.gz"
# COPYFILE_DISABLE keeps macOS bsdtar from adding AppleDouble ._ entries.
COPYFILE_DISABLE=1 tar -czf "$OUT/$name" -C "$payload" --exclude=.DS_Store .

sum="$(node -e '
  const h = require("crypto").createHash("sha256");
  h.update(require("fs").readFileSync(process.argv[1]));
  process.stdout.write(h.digest("hex"));
' "$OUT/$name")"
printf '%s  %s\n' "$sum" "$name" > "$OUT/SHA256SUMS"

echo "build-tarball: $name sha256=$sum" >&2
printf '%s\n' "$OUT/$name"
