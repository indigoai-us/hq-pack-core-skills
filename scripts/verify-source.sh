#!/usr/bin/env bash
# verify-source.sh — re-verify that skills/ matches hq-core-staging
# .claude/skills at the SHA recorded in SOURCE.md, minus the core-resident
# skills in core-resident-skills.txt, after applying the recorded transforms
# documented in SOURCE.md.
#
# Needs a local hq-core-staging clone that has the source commit. Not part of
# `npm run check` (CI has no staging checkout). Extracts the source tree,
# removes the core-resident skills, runs apply_recorded_transforms on the
# extracted copy, and compares content with `diff -r` and file executable bits.
#
# Usage: verify-source.sh <hq-core-staging checkout> [sha]
# Exit 0 matches · 1 differs · 2 bad usage.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAGING="${1:-}"
SHA="${2:-04e2312b4b878857e6df10dbef6ba64209d78d55}"

[[ -n "$STAGING" ]] || { echo "usage: verify-source.sh <hq-core-staging checkout> [sha]" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "verify-source: node is required" >&2; exit 2; }
git -C "$STAGING" cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { echo "verify-source: $STAGING does not have commit $SHA" >&2; exit 2; }

# Apply every post-copy transform recorded in SOURCE.md to an extracted
# .claude/skills directory while keeping all file modes unchanged.
apply_recorded_transforms() {
  local dir="$1"
  # 2026-11-24 (US-035): replace literal `hq lanes` with `hq runners`.
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const needle = Buffer.from("hq lanes");
    const replacement = Buffer.from("hq runners");

    function replaceBytes(buf) {
      const chunks = [];
      let pos = 0;
      while (true) {
        const idx = buf.indexOf(needle, pos);
        if (idx === -1) {
          chunks.push(buf.subarray(pos));
          return Buffer.concat(chunks);
        }
        chunks.push(buf.subarray(pos, idx), replacement);
        pos = idx + needle.length;
      }
    }

    function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const raw = fs.readFileSync(full);
          if (raw.includes(needle)) {
            fs.writeFileSync(full, replaceBytes(raw));
          }
        }
      }
    }

    walk(process.argv[1]);
  ' "$dir"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$STAGING" archive "$SHA" .claude/skills | tar -x -C "$tmp"
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  [[ -d "$tmp/.claude/skills/$name" ]] || { echo "verify-source: core-resident skill $name is not in the source tree" >&2; exit 1; }
  rm -rf "${tmp:?}/.claude/skills/$name"
done < <(sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$ROOT/core-resident-skills.txt" | sed '/^$/d')

apply_recorded_transforms "$tmp/.claude/skills"

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
  echo "OK: skills/ matches .claude/skills at $SHA minus the core-resident skills after recorded transforms (content and executable bits)"
fi
exit "$status"
