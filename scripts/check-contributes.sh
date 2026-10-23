#!/usr/bin/env bash
# check-contributes.sh — fail when package.yaml `contributes.skills` and the
# directories under skills/ differ, in either direction.
#
# The list is read with the same shallow grammar hq-cli uses for package.yaml
# (src/lib/scan-packages/index.ts readContributes): a `contributes:` line at
# column 0, two-space key headers, four-space `- item` lines, `key: []` for an
# empty list, `#` comments ignored. A form hq-cli would not read (for example
# an inline `skills: [a, b]`) reads as an empty list here too, and fails.
#
# Also fails on a non-directory entry under skills/, a name listed twice, and
# a list that is not sorted with LC_ALL=C.
#
# Usage: check-contributes.sh [pack-root]   (default: this script's repo)
# Exit 0 match · 1 mismatch · 2 bad usage.

set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
MANIFEST="$ROOT/package.yaml"
SKILLS_DIR="$ROOT/skills"

[[ -f "$MANIFEST" ]] || { echo "check-contributes: no package.yaml at $MANIFEST" >&2; exit 2; }
[[ -d "$SKILLS_DIR" ]] || { echo "check-contributes: no skills dir at $SKILLS_DIR" >&2; exit 2; }

listed="$(awk -v sq="'" '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  /^contributes:[[:space:]]*$/ { inside = 1; key = ""; next }
  inside && /^[^[:space:]]/ { inside = 0; key = ""; next }
  inside && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*\[[[:space:]]*\][[:space:]]*$/ { key = ""; next }
  inside && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$/ {
    key = $0; sub(/^  /, "", key); sub(/:.*$/, "", key); next
  }
  inside && key == "skills" && /^    -[[:space:]]+/ {
    v = $0
    sub(/^    -[[:space:]]+/, "", v)
    sub(/[[:space:]]*#.*$/, "", v)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
    first = substr(v, 1, 1); last = substr(v, length(v), 1)
    if (length(v) >= 2 && first == last && (first == "\"" || first == sq)) v = substr(v, 2, length(v) - 2)
    if (v != "") print v
  }
' "$MANIFEST")"

status=0
fail() { printf 'check-contributes: %s\n' "$1" >&2; status=1; }

dirs=""
while IFS= read -r entry; do
  [[ -n "$entry" ]] || continue
  name="${entry##*/}"
  if [[ -d "$entry" && ! -L "$entry" ]]; then
    dirs+="$name"$'\n'
  else
    fail "skills/$name is not a directory (only skill directories belong under skills/)"
  fi
done < <(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)

sorted_listed="$(printf '%s\n' "$listed" | sed '/^$/d' | LC_ALL=C sort)"
unique_listed="$(printf '%s\n' "$sorted_listed" | LC_ALL=C sort -u)"
sorted_dirs="$(printf '%s' "$dirs" | sed '/^$/d' | LC_ALL=C sort -u)"

while IFS= read -r dup; do
  [[ -n "$dup" ]] && fail "contributes.skills lists $dup more than once"
done < <(printf '%s\n' "$sorted_listed" | sed '/^$/d' | uniq -d)

while IFS= read -r name; do
  [[ -n "$name" ]] && fail "skills/$name exists but is not listed in package.yaml contributes.skills: $name"
done < <(LC_ALL=C comm -13 <(printf '%s\n' "$unique_listed") <(printf '%s\n' "$sorted_dirs"))

while IFS= read -r name; do
  [[ -n "$name" ]] && fail "package.yaml contributes.skills lists $name but skills/$name does not exist: $name"
done < <(LC_ALL=C comm -23 <(printf '%s\n' "$unique_listed") <(printf '%s\n' "$sorted_dirs"))

if [[ -n "$listed" && "$(printf '%s\n' "$listed" | sed '/^$/d')" != "$sorted_listed" ]]; then
  fail "contributes.skills is not sorted (LC_ALL=C sort order)"
fi

if [[ -z "$listed" && -z "$sorted_dirs" ]]; then
  fail "contributes.skills is empty and skills/ has no directories"
fi

if [[ "$status" == 0 ]]; then
  count="$(printf '%s\n' "$unique_listed" | sed '/^$/d' | wc -l | tr -d ' ')"
  echo "OK: contributes.skills matches the $count directories under skills/"
fi
exit "$status"
