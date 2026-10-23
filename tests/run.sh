#!/usr/bin/env bash
# tests/run.sh — fixture tests for the pack's CI checks.
#
# Each case builds a temp copy of the pack (package.yaml, skills/,
# core-resident-skills.txt, commands.json), changes one thing, and runs the
# check scripts from this repo against it with the fixture as the root.
#
# Usage: bash tests/run.sh   (npm test)

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPTS="$REPO/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
failures=()
OUT=""
RC=0

# Make a fresh fixture copy and print its path. Called as $(make_fixture), so
# it runs in a subshell; mktemp gives each call its own directory.
make_fixture() {
  local dir
  dir="$(mktemp -d "$WORK/fixture.XXXXXX")"
  cp -a "$REPO/package.yaml" "$REPO/package.json" "$REPO/core-resident-skills.txt" "$REPO/commands.json" "$dir/"
  cp -a "$REPO/skills" "$dir/skills"
  printf '%s\n' "$dir"
}

# Insert NEW as a line after the first line equal to AFTER in FILE.
insert_after() {
  local file="$1" after="$2" new="$3"
  awk -v after="$after" -v new="$new" '{ print } !done && $0 == after { print new; done = 1 }' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

# Write skills/<dir>/SKILL.md in fixture ROOT with the given frontmatter lines
# and body.
write_skill() {
  local root="$1" dir="$2" front="$3" body="${4:-Body text.}"
  mkdir -p "$root/skills/$dir"
  printf -- '---\n%s\n---\n\n%s\n' "$front" "$body" > "$root/skills/$dir/SKILL.md"
}

regen_commands() {
  bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$1" --json --out "$1/commands.json"
}

capture() {
  OUT="$("$@" 2>&1)"
  RC=$?
}

ok() { pass=$((pass + 1)); echo "ok   $1"; }
not_ok() { failures+=("$1"); echo "FAIL $1"; printf '%s\n' "$2" | sed 's/^/     | /'; }

# expect_fail NAME PATTERN CMD... : CMD exits non-zero and its output has PATTERN.
expect_fail() {
  local name="$1" pattern="$2"; shift 2
  capture "$@"
  if [[ "$RC" -eq 0 ]]; then
    not_ok "$name" "expected a non-zero exit, got 0. Output: $OUT"
  elif ! grep -qF -- "$pattern" <<<"$OUT"; then
    not_ok "$name" "exit $RC but output lacks '$pattern'. Output: $OUT"
  else
    ok "$name"
  fi
}

# expect_pass NAME CMD... : CMD exits 0.
expect_pass() {
  local name="$1"; shift
  capture "$@"
  if [[ "$RC" -eq 0 ]]; then ok "$name"; else not_ok "$name" "exit $RC. Output: $OUT"; fi
}

# --- clean tree --------------------------------------------------------------

root="$(make_fixture)"
expect_pass "clean tree: check.sh passes" bash "$SCRIPTS/check.sh" "$root"
expect_pass "clean tree: check-contributes passes" bash "$SCRIPTS/check-contributes.sh" "$root"
expect_pass "clean tree: check-frontmatter passes" bash "$SCRIPTS/check-frontmatter.sh" "$root"
expect_pass "clean tree: company-bind lint passes" bash "$SCRIPTS/vendor/lint-skill-company-bind.sh" "$root/skills"
expect_pass "clean tree: commands.json is current" bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$root" --check
expect_pass "repo tree: check.sh passes" bash "$SCRIPTS/check.sh"

# --- package.json / package.yaml sync ---------------------------------------------

# Rewrite package.json in fixture ROOT with a JS expression applied to `p`.
edit_pkg_json() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    new Function("p", process.argv[2])(p);
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  ' "$1/package.json" "$2"
}
# Replace the first line equal to OLD with NEW in FILE.
replace_line() {
  awk -v old="$2" -v new="$3" '{ if (!done && $0 == old) { print new; done = 1 } else print }' "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
}

root="$(make_fixture)"
expect_pass "manifest sync: clean tree passes" node "$SCRIPTS/check-manifest-sync.mjs" "$root"

root="$(make_fixture)"
edit_pkg_json "$root" 'p.version = "1.0.1"'
expect_fail "package.json version differs from package.yaml version: fails" \
  'package.json version is "1.0.1" but package.yaml version is "1.0.0"' node "$SCRIPTS/check-manifest-sync.mjs" "$root"
expect_fail "version mismatch fails check.sh on manifest-sync" "FAILED: manifest-sync" bash "$SCRIPTS/check.sh" "$root"

root="$(make_fixture)"
replace_line "$root/package.yaml" "version: 1.0.0" "version: 1.1.0"
expect_fail "package.yaml version bumped without package.json: fails" \
  'package.json version is "1.0.0" but package.yaml version is "1.1.0"' node "$SCRIPTS/check-manifest-sync.mjs" "$root"

root="$(make_fixture)"
edit_pkg_json "$root" 'p.engines["hq-core"] = ">=17.0.0"'
expect_fail "engines hq-core differs from requires.hqCore: fails" \
  'package.json engines["hq-core"] is ">=17.0.0" but package.yaml requires.hqCore' node "$SCRIPTS/check-manifest-sync.mjs" "$root"
expect_fail "engines hq-core mismatch fails check.sh on manifest-sync" "FAILED: manifest-sync" bash "$SCRIPTS/check.sh" "$root"

root="$(make_fixture)"
edit_pkg_json "$root" 'p.engines["hq-cli"] = ">=6.0.0"'
expect_fail "engines hq-cli differs from requires.hqCli: fails" \
  'package.json engines["hq-cli"] is ">=6.0.0" but package.yaml requires.hqCli' node "$SCRIPTS/check-manifest-sync.mjs" "$root"
expect_fail "engines hq-cli mismatch fails check.sh on manifest-sync" "FAILED: manifest-sync" bash "$SCRIPTS/check.sh" "$root"

root="$(make_fixture)"
replace_line "$root/package.yaml" "  hqCli: '>=5.345.161'" "  hqCli: '>=5.400.0'"
expect_fail "requires.hqCli raised without package.json engines: fails" \
  'package.yaml requires.hqCli is ">=5.400.0"' node "$SCRIPTS/check-manifest-sync.mjs" "$root"

root="$(make_fixture)"
edit_pkg_json "$root" 'delete p.engines["hq-core"]'
expect_fail "missing engines hq-core: fails" \
  'package.json engines["hq-core"] is missing' node "$SCRIPTS/check-manifest-sync.mjs" "$root"

root="$(make_fixture)"
awk '!/^  hqCli:/' "$root/package.yaml" > "$root/package.yaml.tmp" && mv "$root/package.yaml.tmp" "$root/package.yaml"
expect_fail "missing requires.hqCli: fails" \
  'package.yaml requires.hqCli is missing' node "$SCRIPTS/check-manifest-sync.mjs" "$root"

# --- contributes ---------------------------------------------------------------

# PRD e2e: a PR adds skills/foo without listing it -> check-contributes fails and names foo.
root="$(make_fixture)"
write_skill "$root" foo 'name: foo
description: Fixture skill.'
regen_commands "$root"
expect_fail "unlisted skills/foo: check-contributes fails and names foo" \
  "is not listed in package.yaml contributes.skills: foo" bash "$SCRIPTS/check-contributes.sh" "$root"
expect_fail "unlisted skills/foo: check.sh fails on contributes" \
  "FAILED: contributes" bash "$SCRIPTS/check.sh" "$root"

root="$(make_fixture)"
insert_after "$root/package.yaml" "    - worktree" "    - zzz-missing"
expect_fail "listed but missing directory: names the item" \
  "lists zzz-missing but skills/zzz-missing does not exist" bash "$SCRIPTS/check-contributes.sh" "$root"

root="$(make_fixture)"
insert_after "$root/package.yaml" "    - prd" "    - prd"
expect_fail "item listed twice fails" "lists prd more than once" bash "$SCRIPTS/check-contributes.sh" "$root"

root="$(make_fixture)"
awk '$0 == "    - accept" { held = $0; next } { print } $0 == "    - adr" && held { print held; held = "" }' \
  "$root/package.yaml" > "$root/package.yaml.tmp" && mv "$root/package.yaml.tmp" "$root/package.yaml"
expect_fail "unsorted list fails" "is not sorted" bash "$SCRIPTS/check-contributes.sh" "$root"

root="$(make_fixture)"
awk -v sq="'" '{ if ($0 == "    - prd") print "    - \"prd\""; else if ($0 == "    - tdd") print "    - " sq "tdd" sq "  # quoted"; else print }' \
  "$root/package.yaml" > "$root/package.yaml.tmp" && mv "$root/package.yaml.tmp" "$root/package.yaml"
expect_pass "quoted and commented list items are read like hq-cli reads them" bash "$SCRIPTS/check-contributes.sh" "$root"

root="$(make_fixture)"
printf 'stray\n' > "$root/skills/NOTES.md"
expect_fail "non-directory entry under skills/ fails" \
  "skills/NOTES.md is not a directory" bash "$SCRIPTS/check-contributes.sh" "$root"

root="$(make_fixture)"
awk '{ print } $0 == "contributes:" { exit }' "$REPO/package.yaml" > "$root/package.yaml"
printf '  skills: [accept, adr]\n' >> "$root/package.yaml"
expect_fail "inline list (not read by hq-cli) fails" \
  "is not listed in package.yaml contributes.skills: prd" bash "$SCRIPTS/check-contributes.sh" "$root"

# --- frontmatter ---------------------------------------------------------------

# A listed skill with the commands.json regenerated, so only the frontmatter rule can fail.
listed_skill() {
  local root="$1" dir="$2" front="$3" body="${4:-Body text.}"
  write_skill "$root" "$dir" "$front" "$body"
  insert_after "$root/package.yaml" "    - finish-estimate" "    - $dir"
  regen_commands "$root"
}

# PRD e2e: a PR adds a skill with a skill_uid field -> the frontmatter check fails.
root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.
skill_uid: 01HXFIXTURE0000000000000000'
expect_fail "skill_uid in frontmatter: check-frontmatter fails" \
  "frontmatter has a skill_uid field" bash "$SCRIPTS/check-frontmatter.sh" "$root"
expect_fail "skill_uid in frontmatter: check.sh fails on frontmatter only" \
  "FAILED: frontmatter" bash "$SCRIPTS/check.sh" "$root"
if grep -q "FAILED: frontmatter$" <<<"$OUT"; then ok "skill_uid in frontmatter: no other check fails"; else not_ok "skill_uid in frontmatter: no other check fails" "$OUT"; fi

root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.
metadata:
  skill_uid: 01HXFIXTURE0000000000000000'
expect_fail "nested skill_uid in frontmatter fails" \
  "frontmatter has a skill_uid field" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.' 'Preserve `skill_uid` when editing. skill_uid: is set by the registry.'
expect_pass "skill_uid mentioned only in the body passes" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
listed_skill "$root" foo 'name: bar
description: Fixture skill.'
expect_fail "frontmatter name differs from directory fails" \
  "frontmatter name is 'bar', expected 'foo'" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
listed_skill "$root" foo "name: 'foo'
description: Fixture skill."
expect_pass "quoted frontmatter name equal to directory passes" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
listed_skill "$root" foo 'description: Fixture skill.'
expect_fail "missing frontmatter name fails" "has no name field" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
mkdir -p "$root/skills/foo"
printf '# foo\n\nNo frontmatter.\n' > "$root/skills/foo/SKILL.md"
expect_fail "SKILL.md without frontmatter fails" \
  "does not start with a --- frontmatter block" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
mkdir -p "$root/skills/foo"
printf -- '---\nname: foo\n' > "$root/skills/foo/SKILL.md"
expect_fail "unclosed frontmatter fails" "frontmatter is not closed" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
mkdir -p "$root/skills/foo"
printf 'helper\n' > "$root/skills/foo/notes.md"
expect_fail "skill directory without SKILL.md fails" "skills/foo has no SKILL.md" bash "$SCRIPTS/check-frontmatter.sh" "$root"

root="$(make_fixture)"
write_skill "$root" _shared 'name: _shared'
expect_fail "_shared with a SKILL.md fails" \
  "must not contain SKILL.md" bash "$SCRIPTS/check-frontmatter.sh" "$root"

while IFS= read -r resident; do
  [[ -n "$resident" ]] || continue
  root="$(make_fixture)"
  write_skill "$root" "$resident" "name: $resident
description: Fixture copy of a core-resident skill."
  expect_fail "core-resident skill $resident under skills/ fails" \
    "skills/$resident is a core-resident skill" bash "$SCRIPTS/check-frontmatter.sh" "$root"
done < <(sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' "$REPO/core-resident-skills.txt" | sed '/^$/d')

root="$(make_fixture)"
: > "$root/core-resident-skills.txt"
expect_fail "empty core-resident list is bad usage" "lists no skills" bash "$SCRIPTS/check-frontmatter.sh" "$root"

# --- company bind ----------------------------------------------------------------

root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.' 'Set `{co}` from the argument.

Read companies/{co}/policies/ next.'
expect_fail "company read before bind fails the vendored lint" \
  "reads a company path before the session is bound" bash "$SCRIPTS/vendor/lint-skill-company-bind.sh" "$root/skills"
expect_fail "company read before bind fails check.sh" "FAILED: company-bind" bash "$SCRIPTS/check.sh" "$root"

root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.' 'Set `{co}` from the argument.

Run bash core/scripts/work-mesh-live-bind-trusted.sh --company "{co}".

Read companies/{co}/policies/ next.'
expect_pass "company read after bind passes the vendored lint" bash "$SCRIPTS/vendor/lint-skill-company-bind.sh" "$root/skills"

# --- commands.json ---------------------------------------------------------------

root="$(make_fixture)"
awk '{ if (!done && /^description:/) { print "description: Drifted description for the fixture."; done = 1 } else print }' \
  "$root/skills/prd/SKILL.md" > "$root/skills/prd/SKILL.md.tmp" && mv "$root/skills/prd/SKILL.md.tmp" "$root/skills/prd/SKILL.md"
expect_fail "SKILL.md edit without regenerating commands.json fails" \
  "stale generated file: commands.json" bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$root" --check
expect_fail "commands.json drift fails check.sh" "FAILED: commands-json" bash "$SCRIPTS/check.sh" "$root"
regen_commands "$root"
expect_pass "regenerated commands.json passes" bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$root" --check

root="$(make_fixture)"
rm "$root/commands.json"
expect_fail "missing commands.json fails" "stale generated file: commands.json" \
  bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$root" --check

root="$(make_fixture)"
listed_skill "$root" foo 'name: foo
description: Fixture skill.'
if node -e 'const d=require(process.argv[1]); const e=d.skills.find(s=>s.invoke==="/foo"); process.exit(e && e.scope==="core" && e.source==="skills/foo/SKILL.md" && !d.skills.some(s=>s.invoke==="/_shared") ? 0 : 1)' "$root/commands.json"; then
  ok "commands.json lists a new skill unprefixed with scope core and skips _shared"
else
  not_ok "commands.json lists a new skill unprefixed with scope core and skips _shared" "$(head -c 400 "$root/commands.json")"
fi

# --- manifests and CI ---------------------------------------------------------------

check_manifest() {
  local y="$REPO/package.yaml"
  grep -qx 'name: hq-pack-core-skills' "$y" \
    && grep -qx "publisher: '@indigoai-us'" "$y" \
    && grep -qx 'access: public' "$y" \
    && grep -qx 'surface: unprefixed' "$y" \
    && grep -qE "^  hqCore: '[^']+'$" "$y" \
    && grep -qE "^  hqCli: '[^']+'$" "$y" \
    && node "$SCRIPTS/check-manifest-sync.mjs" "$REPO" >/dev/null \
    && node -e '
      const p = require(process.argv[1]);
      const need = ["package.yaml", "skills/", "SOURCE.md", "commands.json", "README.md", "LICENSE"];
      const ok = p.name === "@indigoai-us/hq-pack-core-skills"
        && need.every((f) => p.files.includes(f))
        && p.publishConfig && p.publishConfig.access === "public"
        && p.repository && /github\.com\/indigoai-us\/hq-pack-core-skills/.test(p.repository.url)
        && p.scripts.check && p.scripts.test;
      process.exit(ok ? 0 : 1);
    ' "$REPO/package.json"
}
if check_manifest; then ok "package.yaml and package.json carry the required fields"; else not_ok "package.yaml and package.json carry the required fields" "see package.yaml / package.json"; fi

check_ci() {
  local ci="$REPO/.github/workflows/ci.yml"
  [[ -f "$ci" ]] || return 1
  # Exactly one job under jobs:.
  [[ "$(awk '/^jobs:/ { inside = 1; next } inside && /^[^ ]/ { inside = 0 } inside && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { n++ } END { print n + 0 }' "$ci")" == 1 ]] \
    && grep -qE '^    runs-on: ubuntu-latest$' "$ci" \
    && grep -qF 'if: github.event.pull_request.draft == false' "$ci" \
    && grep -qF 'types: [opened, synchronize, reopened, ready_for_review]' "$ci" \
    && grep -qE 'run: npm run check$' "$ci" \
    && ! grep -qE '^  (push|schedule|workflow_dispatch):' "$ci" \
    && ! grep -qE 'macos|windows' "$ci"
}
if check_ci; then ok "ci.yml: one ubuntu job on non-draft pull requests running npm run check"; else not_ok "ci.yml: one ubuntu job on non-draft pull requests running npm run check" "see .github/workflows/ci.yml"; fi

echo
echo "$pass passed, ${#failures[@]} failed"
if [[ "${#failures[@]}" -gt 0 ]]; then
  printf '  failed: %s\n' "${failures[@]}"
  exit 1
fi
