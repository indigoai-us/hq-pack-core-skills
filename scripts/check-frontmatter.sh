#!/usr/bin/env bash
# check-frontmatter.sh — per-skill frontmatter rules for skills/<dir>/SKILL.md.
#
# For every directory under skills/:
#   - its name is not in core-resident-skills.txt (those skills stay in
#     hq-core and must not ship in this pack);
#   - a directory whose name starts with `_` (for example `_shared`) holds
#     shared helpers, is not a skill, and must not contain SKILL.md;
#   - any other directory has SKILL.md starting with a `---` frontmatter block
#     that is closed by a second `---` line;
#   - frontmatter `name` equals the directory name;
#   - frontmatter has no `skill_uid` key at any indentation. Body text that
#     mentions skill_uid is fine.
#
# Usage: check-frontmatter.sh [pack-root]   (default: this script's repo)
# Exit 0 clean · 1 violations found · 2 bad usage.

set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
SKILLS_DIR="$ROOT/skills"
RESIDENT_FILE="$ROOT/core-resident-skills.txt"

[[ -d "$SKILLS_DIR" ]] || { echo "check-frontmatter: no skills dir at $SKILLS_DIR" >&2; exit 2; }
[[ -f "$RESIDENT_FILE" ]] || { echo "check-frontmatter: no core-resident list at $RESIDENT_FILE" >&2; exit 2; }

resident="$(sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$RESIDENT_FILE" | sed '/^$/d')"
[[ -n "$resident" ]] || { echo "check-frontmatter: $RESIDENT_FILE lists no skills" >&2; exit 2; }

status=0
fail() { printf 'check-frontmatter: %s\n' "$1" >&2; status=1; }

checked=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  [[ -d "$dir" ]] || continue
  name="${dir##*/}"
  skill_md="$dir/SKILL.md"

  if printf '%s\n' "$resident" | grep -qxF -- "$name"; then
    fail "skills/$name is a core-resident skill (core-resident-skills.txt); it stays in hq-core and must not ship in this pack"
  fi

  if [[ "$name" == _* ]]; then
    [[ -e "$skill_md" ]] && fail "skills/$name/SKILL.md: directories starting with _ hold shared helpers and must not contain SKILL.md"
    continue
  fi

  if [[ ! -f "$skill_md" ]]; then
    fail "skills/$name has no SKILL.md"
    continue
  fi
  checked=$((checked + 1))

  report="$(awk -v sq="'" '
    { sub(/\r$/, "") }
    NR == 1 { if ($0 !~ /^---[ \t]*$/) { print "NOFM"; exit } in_fm = 1; next }
    in_fm && /^---[ \t]*$/ { closed = 1; exit }
    in_fm && /^[ \t]*skill_uid[ \t]*:/ { print "UID " NR }
    in_fm && /^name[ \t]*:/ && !have_name {
      v = $0
      sub(/^name[ \t]*:[ \t]*/, "", v)
      sub(/[ \t]+$/, "", v)
      first = substr(v, 1, 1); last = substr(v, length(v), 1)
      if (length(v) >= 2 && first == last && (first == "\"" || first == sq)) v = substr(v, 2, length(v) - 2)
      print "NAME " v
      have_name = 1
    }
    END { if (in_fm && !closed) print "UNCLOSED" }
  ' "$skill_md")"

  if grep -qx 'NOFM' <<<"$report"; then
    fail "skills/$name/SKILL.md does not start with a --- frontmatter block"
    continue
  fi
  if grep -qx 'UNCLOSED' <<<"$report"; then
    fail "skills/$name/SKILL.md frontmatter is not closed by a --- line"
    continue
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && fail "skills/$name/SKILL.md:${line#UID }: frontmatter has a skill_uid field; pack skills must not carry skill_uid"
  done < <(grep '^UID ' <<<"$report" || true)
  fm_name="$(sed -n 's/^NAME //p' <<<"$report")"
  if ! grep -q '^NAME ' <<<"$report"; then
    fail "skills/$name/SKILL.md frontmatter has no name field (expected name: $name)"
  elif [[ "$fm_name" != "$name" ]]; then
    fail "skills/$name/SKILL.md frontmatter name is '$fm_name', expected '$name' (the directory name)"
  fi
done < <(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)

[[ "$checked" -gt 0 ]] || fail "no SKILL.md found under skills/"
[[ "$status" == 0 ]] && echo "OK: $checked SKILL.md files have name = directory, no skill_uid, no core-resident name"
exit "$status"
