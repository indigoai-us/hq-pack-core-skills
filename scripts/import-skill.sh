#!/usr/bin/env bash
# import-skill.sh — copy a company or personal skill into this pack.
#
#   bash scripts/import-skill.sh [--allow-hq-paths] [--root <pack-root>] <skill-dir>
#
# <skill-dir> is a skill directory with a SKILL.md, for example
# <hq>/companies/<co>/skills/foo or <hq>/personal/skills/foo. The script:
#
#   1. Reads frontmatter `name`. It must equal the directory name, must not
#      start with `_`, and must not already be in skills/, in
#      contributes.skills, or in core-resident-skills.txt. A skill with
#      `private: true` is refused (promote-hq-core treats it as never-core).
#      The source must contain no symlinks.
#   2. Copies the directory to skills/<name>/.
#   3. Removes company-only frontmatter keys from skills/<name>/SKILL.md:
#      skill_uid, company, title, tags, status, sandbox (with any indented or
#      `- item` lines under them), and any nested skill_uid line. The body is
#      not changed.
#   4. Adds <name> to package.yaml contributes.skills in LC_ALL=C order and
#      regenerates commands.json.
#   5. Runs the checks below. Any finding fails the import.
#        company-bind  scripts/vendor/lint-skill-company-bind.sh on the skill
#        path-filter   scripts/vendor/skill-has-unshipped-hq-path.sh: the skill
#                      names a core/ or .claude/ path rooted in the HQ checkout,
#                      so hq-core's Claude plugin and Codex pack builds leave it
#                      out. --allow-hq-paths accepts that and skips this check.
#        company-slug  a company slug hard-coded in any file of the skill: the
#                      source company (from the path or frontmatter `company`)
#                      as a whole word, or any slug in the source HQ's
#                      companies/manifest.yaml as companies/<slug> or
#                      --company <slug>.
#        pack-check    scripts/check.sh, the same checks as `npm run check`.
#
# On any failure the pack is put back as it was: skills/<name>/ is removed and
# package.yaml and commands.json are restored. Nothing is committed.
#
# Exit 0 imported · 1 refused or findings · 2 bad usage.

set -uo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPTS/.." && pwd -P)"
ALLOW_HQ_PATHS=0
SRC=""

usage() {
  echo "usage: import-skill.sh [--allow-hq-paths] [--root <pack-root>] <skill-dir>" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-hq-paths) ALLOW_HQ_PATHS=1; shift ;;
    --root) [[ $# -ge 2 ]] || usage; ROOT="$(cd "$2" 2>/dev/null && pwd -P)" || { echo "import-skill: no pack root at $2" >&2; exit 2; }; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "import-skill: unknown option $1" >&2; usage ;;
    *) [[ -z "$SRC" ]] || usage; SRC="$1"; shift ;;
  esac
done
[[ -n "$SRC" ]] || usage

refuse() { printf 'import-skill: %s\n' "$1" >&2; exit 1; }

[[ -d "$SRC" ]] || { echo "import-skill: not a directory: $SRC" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd -P)"
SRC_MD="$SRC/SKILL.md"
[[ -f "$SRC_MD" ]] || { echo "import-skill: no SKILL.md in $SRC" >&2; exit 2; }
for f in package.yaml commands.json core-resident-skills.txt; do
  [[ -f "$ROOT/$f" ]] || { echo "import-skill: no $f at $ROOT" >&2; exit 2; }
done
[[ -d "$ROOT/skills" ]] || { echo "import-skill: no skills/ at $ROOT" >&2; exit 2; }

# --- read the source frontmatter ------------------------------------------------

# Print the value of top-level frontmatter KEY in FILE, unquoted ("" if absent).
fm_value() {
  awk -v key="$2" -v sq="'" '
    { sub(/\r$/, "") }
    NR == 1 { if ($0 !~ /^---[ \t]*$/) exit; next }
    /^---[ \t]*$/ { exit }
    $0 ~ ("^" key "[ \t]*:") {
      v = $0
      sub(/^[^:]*:[ \t]*/, "", v)
      sub(/[ \t]+#.*$/, "", v)
      sub(/[ \t]+$/, "", v)
      first = substr(v, 1, 1); last = substr(v, length(v), 1)
      if (length(v) >= 2 && first == last && (first == "\"" || first == sq)) v = substr(v, 2, length(v) - 2)
      print v
      exit
    }
  ' "$1"
}

head -n 1 "$SRC_MD" | grep -qE '^---[[:space:]]*$' || refuse "$SRC_MD does not start with a --- frontmatter block"
awk 'NR > 1 && /^---[ \t]*\r?$/ { found = 1; exit } END { exit found ? 0 : 1 }' "$SRC_MD" \
  || refuse "$SRC_MD frontmatter is not closed by a --- line"

NAME="$(fm_value "$SRC_MD" name)"
[[ -n "$NAME" ]] || refuse "$SRC_MD has no frontmatter name"
DIR_NAME="${SRC##*/}"
[[ "$NAME" == "$DIR_NAME" ]] || refuse "frontmatter name is '$NAME' but the directory is '$DIR_NAME'; they must be equal"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || refuse "skill name '$NAME' must be lower-case letters, digits, '.', '_' or '-', and must not start with '_'"

private="$(fm_value "$SRC_MD" private)"
[[ "$private" != "true" ]] || refuse "$NAME has private: true; private skills are never promoted to core"

# --- refuse a name the pack already has -------------------------------------------

[[ ! -e "$ROOT/skills/$NAME" ]] || refuse "skills/$NAME already exists in the pack; pick another name or change the existing skill by pull request"
if sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$ROOT/core-resident-skills.txt" | grep -qxF -- "$NAME"; then
  refuse "$NAME is a core-resident skill (core-resident-skills.txt); it stays in hq-core and cannot be imported"
fi

# contributes.skills items, read like scripts/check-contributes.sh reads them.
listed_skills() {
  awk -v sq="'" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^contributes:[[:space:]]*$/ { inside = 1; key = ""; next }
    inside && /^[^[:space:]]/ { inside = 0; key = ""; next }
    inside && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$/ { key = $0; sub(/^  /, "", key); sub(/:.*$/, "", key); next }
    inside && /^  [A-Za-z_][A-Za-z0-9_-]*:/ { key = ""; next }
    inside && key == "skills" && /^    -[[:space:]]+/ {
      v = $0
      sub(/^    -[[:space:]]+/, "", v); sub(/[[:space:]]*#.*$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      first = substr(v, 1, 1); last = substr(v, length(v), 1)
      if (length(v) >= 2 && first == last && (first == "\"" || first == sq)) v = substr(v, 2, length(v) - 2)
      if (v != "") print v
    }
  ' "$1"
}
listed_skills "$ROOT/package.yaml" | grep -qxF -- "$NAME" \
  && refuse "package.yaml contributes.skills already lists $NAME"

if [[ -n "$(find "$SRC" -type l -print -quit)" ]]; then
  refuse "$SRC contains a symlink ($(find "$SRC" -type l -print -quit)); copy the target into the skill instead"
fi

# --- company slugs known for this source -------------------------------------------

SOURCE_SLUGS=()   # matched as a whole word
KNOWN_SLUGS=()    # matched as companies/<slug> or --company <slug>
valid_slug() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; }

case "$SRC" in
  */companies/*/skills/*)
    rest="${SRC%/skills/*}"
    co="${rest##*/companies/}"
    hq_root="${rest%/companies/*}"
    valid_slug "$co" && SOURCE_SLUGS+=("$co")
    ;;
  */personal/skills/*)
    hq_root="${SRC%/personal/skills/*}"
    ;;
  *) hq_root="" ;;
esac
fm_company="$(fm_value "$SRC_MD" company)"
if [[ -n "$fm_company" ]] && valid_slug "$fm_company"; then SOURCE_SLUGS+=("$fm_company"); fi
if [[ -n "$hq_root" && -f "$hq_root/companies/manifest.yaml" ]]; then
  while IFS= read -r s; do
    valid_slug "$s" && KNOWN_SLUGS+=("$s")
  done < <(awk '
    /^companies:[[:space:]]*$/ { inside = 1; next }
    inside && /^[^[:space:]#]/ { inside = 0 }
    inside && /^  [A-Za-z0-9_-]+:/ { s = $0; sub(/^  /, "", s); sub(/:.*$/, "", s); print s }
  ' "$hq_root/companies/manifest.yaml")
fi
KNOWN_SLUGS+=("${SOURCE_SLUGS[@]+"${SOURCE_SLUGS[@]}"}")

# --- copy, with rollback on any failure -------------------------------------------

BACKUP="$(mktemp -d)"
cp -p "$ROOT/package.yaml" "$BACKUP/package.yaml"
cp -p "$ROOT/commands.json" "$BACKUP/commands.json"
DEST="$ROOT/skills/$NAME"
CREATED=0
DONE=0

rollback() {
  if [[ "$DONE" != 1 ]]; then
    [[ "$CREATED" == 1 ]] && rm -rf "$DEST"
    cp -p "$BACKUP/package.yaml" "$ROOT/package.yaml"
    cp -p "$BACKUP/commands.json" "$ROOT/commands.json"
    echo "import-skill: $NAME not imported; the pack is unchanged" >&2
  fi
  rm -rf "$BACKUP"
}
trap rollback EXIT
trap 'exit 1' INT TERM

CREATED=1
cp -R "$SRC" "$DEST" || exit 1
find "$DEST" -name .DS_Store -type f -delete

# --- strip company-only frontmatter ------------------------------------------------

STRIP_KEYS="skill_uid company title tags status sandbox"
stripped="$(awk -v keys="$STRIP_KEYS" -v out="$DEST/SKILL.md.tmp" '
  BEGIN { n = split(keys, k, " "); for (i = 1; i <= n; i++) strip[k[i]] = 1 }
  NR == 1 { print > out; in_fm = 1; next }
  in_fm && /^---[ \t]*\r?$/ { in_fm = 0; skipping = 0; print > out; next }
  in_fm {
    if (match($0, /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/)) {
      key = substr($0, 1, RLENGTH); sub(/[ \t]*:$/, "", key)
      if (key in strip) { skipping = 1; seen[key] = 1; next }
      skipping = 0
    } else if (skipping && ($0 ~ /^[ \t]/ || $0 ~ /^-/ || $0 ~ /^[ \t]*\r?$/)) {
      next
    } else {
      skipping = 0
    }
    if ($0 ~ /^[ \t]+skill_uid[ \t]*:/) { seen["nested skill_uid"] = 1; next }
  }
  { print > out }
  END { for (s in seen) print s }
' "$DEST/SKILL.md")" || exit 1
mv "$DEST/SKILL.md.tmp" "$DEST/SKILL.md"
stripped="$(printf '%s\n' "$stripped" | sed '/^$/d' | LC_ALL=C sort | paste -sd, - | sed "s/,/, /g")"

# --- contributes.skills and commands.json -----------------------------------------

LC_ALL=C awk -v name="$NAME" -v sq="'" -v out="$ROOT/package.yaml.tmp" '
  function item(line,   v, first, last) {
    v = line
    sub(/^    -[[:space:]]+/, "", v); sub(/[[:space:]]*#.*$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
    first = substr(v, 1, 1); last = substr(v, length(v), 1)
    if (length(v) >= 2 && first == last && (first == "\"" || first == sq)) v = substr(v, 2, length(v) - 2)
    return v
  }
  function flush() { if (in_skills && !done) { print "    - " name > out; done = 1 } }
  /^contributes:[[:space:]]*$/ { inside = 1; print > out; next }
  inside && /^[^[:space:]#]/ { flush(); inside = 0; in_skills = 0 }
  inside && /^  [A-Za-z_][A-Za-z0-9_-]*:/ {
    flush(); in_skills = ($0 ~ /^  skills:[[:space:]]*$/); found = found || in_skills; print > out; next
  }
  in_skills && !done && /^    -[[:space:]]+/ && item($0) > name { print "    - " name > out; done = 1 }
  { print > out }
  END { flush(); exit (found && done) ? 0 : 1 }
' "$ROOT/package.yaml" || { rm -f "$ROOT/package.yaml.tmp"; echo "import-skill: package.yaml has no contributes.skills block list" >&2; exit 1; }
mv "$ROOT/package.yaml.tmp" "$ROOT/package.yaml"

bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$ROOT" --json --out "$ROOT/commands.json" >/dev/null \
  || { echo "import-skill: regenerating commands.json failed" >&2; exit 1; }

# --- findings -----------------------------------------------------------------------

findings=()

lint_dir="$(mktemp -d "$BACKUP/lint.XXXXXX")"
ln -s "$DEST" "$lint_dir/$NAME"
if ! out="$(bash "$SCRIPTS/vendor/lint-skill-company-bind.sh" "$lint_dir" 2>&1)"; then
  printf "%s\n" "$out" | sed "s|$lint_dir/|skills/|g" >&2
  findings+=("company-bind")
fi

if bash "$SCRIPTS/vendor/skill-has-unshipped-hq-path.sh" "$DEST/SKILL.md"; then
  if [[ "$ALLOW_HQ_PATHS" == 1 ]]; then
    echo "import-skill: note: skills/$NAME/SKILL.md names a core/ or .claude/ path, so hq-core's Claude plugin and Codex pack builds leave it out (--allow-hq-paths)"
  else
    echo "import-skill: skills/$NAME/SKILL.md names a core/ or .claude/ path rooted in the HQ checkout (scripts/vendor/skill-has-unshipped-hq-path.sh), so hq-core's Claude plugin and Codex pack builds would leave it out. Rewrite the path, or pass --allow-hq-paths to import it as HQ-only." >&2
    findings+=("path-filter")
  fi
fi

slug_hits=""
# Whole-word matches of the source company slug, then path and flag forms of every known slug.
for s in "${SOURCE_SLUGS[@]+"${SOURCE_SLUGS[@]}"}"; do
  slug_hits+="$(grep -rInE -- "(^|[^A-Za-z0-9_-])${s}([^A-Za-z0-9_-]|$)" "$DEST" 2>/dev/null)"$'\n'
done
for s in "${KNOWN_SLUGS[@]+"${KNOWN_SLUGS[@]}"}"; do
  slug_hits+="$(grep -rInE -- "companies/${s}([^A-Za-z0-9_-]|$)|--company[= ]+[\"']?${s}([^A-Za-z0-9_-]|$)" "$DEST" 2>/dev/null)"$'\n'
done
slug_hits="$(printf '%s\n' "$slug_hits" | sed '/^$/d' | LC_ALL=C sort -u)"
if [[ -n "$slug_hits" ]]; then
  echo "import-skill: skills/$NAME hard-codes a company slug; use a placeholder such as {co} and bind the session first:" >&2
  printf '%s\n' "$slug_hits" | sed "s|^$ROOT/||" | head -40 | sed 's/^/  /' >&2
  findings+=("company-slug")
fi

if ! out="$(bash "$SCRIPTS/check.sh" "$ROOT" 2>&1)"; then
  printf '%s\n' "$out" >&2
  findings+=("pack-check")
fi

if [[ "${#findings[@]}" -gt 0 ]]; then
  echo "import-skill: FAILED: ${findings[*]}" >&2
  exit 1
fi

DONE=1
echo "Imported $NAME into skills/$NAME/"
echo "  stripped frontmatter: ${stripped:-none}"
echo "  package.yaml contributes.skills: added $NAME"
echo "  commands.json: regenerated"
echo "Next: review the diff, run npm test, and open a pull request (CONTRIBUTING.md)."
