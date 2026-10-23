#!/usr/bin/env bash
# verify-source.sh — re-verify that skills/ is byte-identical to hq-core-staging
# .claude/skills at the SHA recorded in SOURCE.md, minus the core-resident
# skills in core-resident-skills.txt.
#
# Needs a local hq-core-staging clone that has the source commit. Not part of
# `npm run check` (CI has no staging checkout). Compares content with
# `diff -r` and the executable bit of every file.
#
# Usage: verify-source.sh <hq-core-staging checkout> [sha]
# Exit 0 identical · 1 differs · 2 bad usage.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAGING="${1:-}"
SHA="${2:-04e2312b4b878857e6df10dbef6ba64209d78d55}"

[[ -n "$STAGING" ]] || { echo "usage: verify-source.sh <hq-core-staging checkout> [sha]" >&2; exit 2; }
git -C "$STAGING" cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { echo "verify-source: $STAGING does not have commit $SHA" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$STAGING" archive "$SHA" .claude/skills | tar -x -C "$tmp"
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  [[ -d "$tmp/.claude/skills/$name" ]] || { echo "verify-source: core-resident skill $name is not in the source tree" >&2; exit 1; }
  rm -rf "${tmp:?}/.claude/skills/$name"
done < <(sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$ROOT/core-resident-skills.txt" | sed '/^$/d')

status=0
if ! diff -r "$tmp/.claude/skills" "$ROOT/skills"; then
  status=1
fi
exec_src="$(cd "$tmp/.claude/skills" && find . -type f -perm -u+x | LC_ALL=C sort)"
exec_pack="$(cd "$ROOT/skills" && find . -type f -perm -u+x | LC_ALL=C sort)"
if [[ "$exec_src" != "$exec_pack" ]]; then
  echo "verify-source: executable bits differ:" >&2
  diff <(printf '%s\n' "$exec_src") <(printf '%s\n' "$exec_pack") >&2 || true
  status=1
fi

if [[ "$status" == 0 ]]; then
  echo "OK: skills/ matches .claude/skills at $SHA minus the core-resident skills (content and executable bits)"
fi
exit "$status"
