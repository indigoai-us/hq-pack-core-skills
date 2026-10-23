# tests/import-skill.test.sh — cases for scripts/import-skill.sh (US-015).
#
# Sourced by tests/run.sh, which provides make_fixture, expect_pass,
# expect_fail, ok, not_ok, capture, $WORK, $SCRIPTS and $REPO. Each case
# imports a source skill from a fake HQ root under $WORK into a fresh fixture
# copy of the pack (--root), never into this repo.

if [[ -z "${SCRIPTS:-}" ]] || ! declare -F make_fixture >/dev/null; then
  echo "tests/import-skill.test.sh is sourced by tests/run.sh; run: bash tests/run.sh" >&2
  return 2 2>/dev/null || exit 2
fi

IMPORT="$SCRIPTS/import-skill.sh"

# A fake HQ root with one company in its manifest besides the source company.
make_hq() {
  local hq
  hq="$(mktemp -d "$WORK/hq.XXXXXX")"
  mkdir -p "$hq/companies"
  printf 'companies:\n  acme:\n    name: Acme\n  globex:\n    name: Globex\n' > "$hq/companies/manifest.yaml"
  printf '%s\n' "$hq"
}

# write_source DIR FRONTMATTER [BODY]: DIR/SKILL.md with that frontmatter.
write_source() {
  local dir="$1" front="$2" body="${3:-Body text.}"
  mkdir -p "$dir"
  printf -- '---\n%s\n---\n\n%s\n' "$front" "$body" > "$dir/SKILL.md"
}

# Fingerprint of every path and file byte under ROOT.
tree_sum() {
  (
    cd "$1" || exit 1
    find . -print | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
  ) | shasum -a 256
}

# expect_unchanged NAME ROOT BEFORE: ROOT's fingerprint equals BEFORE.
expect_unchanged() {
  if [[ "$(tree_sum "$2")" == "$3" ]]; then ok "$1"; else not_ok "$1" "the pack tree changed: $(git -C "$2" status --short 2>/dev/null | head -5)"; fi
}

COMPANY_FRONT='name: foo
title: "Foo"
description: Fixture company skill.
skill_uid: skl_01HXFIXTURE00000000000000
company: acme
tags:
  - ops
  - fixture
allowed-tools: Read, Grep
sandbox:
  command: node run.mjs
  egress: []'

# --- PRD e2e: a company skill with skill_uid imports clean -----------------------

hq="$(make_hq)"
src="$hq/companies/acme/skills/foo"
write_source "$src" "$COMPANY_FRONT" '# Foo

Run the steps for `{co}` after the session is bound.'
mkdir -p "$src/references"
printf 'Reference notes.\n' > "$src/references/notes.md"
root="$(make_fixture)"
expect_pass "import-skill: clean company skill with skill_uid imports" bash "$IMPORT" --root "$root" "$src"
md="$root/skills/foo/SKILL.md"
if [[ -f "$md" ]] && ! grep -q 'skill_uid' "$md"; then ok "import-skill: skills/foo/SKILL.md has no skill_uid"; else not_ok "import-skill: skills/foo/SKILL.md has no skill_uid" "$(cat "$md" 2>/dev/null)"; fi
if bash "$SCRIPTS/check-contributes.sh" "$root" >/dev/null 2>&1 && awk '/^  skills:/ { on = 1; next } on && /^  [a-z]/ { on = 0 } on' "$root/package.yaml" | grep -qx '    - foo'; then
  ok "import-skill: contributes.skills lists foo in sorted position"
else
  not_ok "import-skill: contributes.skills lists foo in sorted position" "$(grep -n 'foo\|finish-estimate\|gc' "$root/package.yaml")"
fi
front="$(awk 'NR == 1 { next } /^---$/ { exit } { print }' "$md")"
if [[ "$front" == $'name: foo\ndescription: Fixture company skill.\nallowed-tools: Read, Grep' ]]; then
  ok "import-skill: strips skill_uid, company, title, tags and sandbox and keeps the rest in order"
else
  not_ok "import-skill: strips skill_uid, company, title, tags and sandbox and keeps the rest in order" "$front"
fi
if [[ "$(awk '/^---$/ { n++; next } n >= 2' "$md")" == "$(awk '/^---$/ { n++; next } n >= 2' "$src/SKILL.md")" ]] \
  && cmp -s "$src/references/notes.md" "$root/skills/foo/references/notes.md"; then
  ok "import-skill: body and other files are copied unchanged"
else
  not_ok "import-skill: body and other files are copied unchanged" "$(diff "$src/SKILL.md" "$md")"
fi
if grep -q 'skill_uid' "$src/SKILL.md"; then ok "import-skill: the source company skill is left in place"; else not_ok "import-skill: the source company skill is left in place" "source SKILL.md changed"; fi
expect_pass "import-skill: commands.json is current after import" bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$root" --check
if node -e 'const d=require(process.argv[1]); process.exit(d.skills.some(s=>s.invoke==="/foo") ? 0 : 1)' "$root/commands.json"; then
  ok "import-skill: commands.json lists /foo"
else
  not_ok "import-skill: commands.json lists /foo" "$(head -c 300 "$root/commands.json")"
fi
expect_pass "import-skill: check.sh passes on the imported tree" bash "$SCRIPTS/check.sh" "$root"

# Names that sort first and last go to the right ends of the list.
hq="$(make_hq)"
root="$(make_fixture)"
write_source "$hq/personal/skills/aaa-first" 'name: aaa-first
description: Sorts right after _shared.'
write_source "$hq/personal/skills/zzz-last" 'name: zzz-last
description: Sorts after every other skill.'
expect_pass "import-skill: personal skill sorting first imports" bash "$IMPORT" --root "$root" "$hq/personal/skills/aaa-first"
expect_pass "import-skill: personal skill sorting last imports" bash "$IMPORT" --root "$root" "$hq/personal/skills/zzz-last"
list="$(awk '/^  skills:/ { on = 1; next } on && /^  [a-z]/ { on = 0 } on && /^    - / { print $2 }' "$root/package.yaml")"
if [[ "$(sed -n 2p <<<"$list")" == aaa-first && "$(tail -n 1 <<<"$list")" == zzz-last ]] && bash "$SCRIPTS/check-contributes.sh" "$root" >/dev/null 2>&1; then
  ok "import-skill: first and last names are inserted in LC_ALL=C order"
else
  not_ok "import-skill: first and last names are inserted in LC_ALL=C order" "$list"
fi

# Nested skill_uid and a quoted name.
hq="$(make_hq)"
root="$(make_fixture)"
write_source "$hq/personal/skills/nested" "name: 'nested'
description: Nested uid.
metadata:
  skill_uid: skl_01HXNESTED0000000000000000
  opencode/slash: \"true\""
expect_pass "import-skill: nested skill_uid is stripped" bash "$IMPORT" --root "$root" "$hq/personal/skills/nested"
if ! grep -q skill_uid "$root/skills/nested/SKILL.md" && grep -q 'opencode/slash' "$root/skills/nested/SKILL.md"; then
  ok "import-skill: nested skill_uid line removed, sibling keys kept"
else
  not_ok "import-skill: nested skill_uid line removed, sibling keys kept" "$(cat "$root/skills/nested/SKILL.md")"
fi

# --- findings fail and leave the tree unchanged ---------------------------------

# PRD: a company skill with skill_uid and a hard-coded company slug fails import.
hq="$(make_hq)"
src="$hq/companies/acme/skills/foo"
write_source "$src" "$COMPANY_FRONT" '# Foo

Read companies/acme/policies/ before you start.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: skill_uid plus hard-coded company slug fails on company-slug" \
  "FAILED: company-slug" bash "$IMPORT" --root "$root" "$src"
grep -qF 'skills/foo/SKILL.md' <<<"$OUT" && ok "import-skill: company-slug finding names the file" || not_ok "import-skill: company-slug finding names the file" "$OUT"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (company slug)" "$root" "$before"

# The same slug as a bare word in prose.
write_source "$src" "$COMPANY_FRONT" 'Post the result to the acme ops channel.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: source company slug as a word fails" "FAILED: company-slug" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (slug word)" "$root" "$before"

# Another company from the source HQ's manifest, in a helper script.
hq="$(make_hq)"
src="$hq/personal/skills/bar"
write_source "$src" 'name: bar
description: Personal skill.'
mkdir -p "$src/scripts"
printf '#!/usr/bin/env bash\nhq sync push --company globex\n' > "$src/scripts/run.sh"
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: manifest company slug in a helper file fails" "FAILED: company-slug" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (manifest slug)" "$root" "$before"

# company-bind lint finding.
hq="$(make_hq)"
src="$hq/companies/acme/skills/foo"
write_source "$src" "$COMPANY_FRONT" 'Set `{co}` from the argument.

Read companies/{co}/policies/ next.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: company read before bind fails on company-bind" \
  "FAILED: company-bind" bash "$IMPORT" --root "$root" "$src"
grep -qF 'reads a company path before the session is bound' <<<"$OUT" && ok "import-skill: company-bind finding is printed" || not_ok "import-skill: company-bind finding is printed" "$OUT"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (company bind)" "$root" "$before"

# Path-aware filter finding, and --allow-hq-paths.
hq="$(make_hq)"
src="$hq/personal/skills/hqpath"
write_source "$src" 'name: hqpath
description: Names an HQ checkout path.' 'Run `bash core/scripts/hq-session.sh show` first.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: HQ checkout path fails on path-filter" "FAILED: path-filter" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (path filter)" "$root" "$before"
expect_pass "import-skill: --allow-hq-paths imports the HQ-only skill" bash "$IMPORT" --allow-hq-paths --root "$root" "$src"
grep -qF 'leave it out' <<<"$OUT" && ok "import-skill: --allow-hq-paths prints the plugin and Codex note" || not_ok "import-skill: --allow-hq-paths prints the plugin and Codex note" "$OUT"

# A pack check failure after the copy rolls back too. The fixture pack has a
# stray file under skills/, which check-contributes rejects.
hq="$(make_hq)"
src="$hq/personal/skills/badcheck"
write_source "$src" 'name: badcheck
description: Fine.'
root="$(make_fixture)"
printf 'stray\n' > "$root/skills/NOTES.md"
before="$(tree_sum "$root")"
expect_fail "import-skill: a pack check failure fails the import" "FAILED: pack-check" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: failed import leaves the pack tree unchanged (pack check)" "$root" "$before"

# --- refusals -------------------------------------------------------------------

hq="$(make_hq)"
src="$hq/personal/skills/prd"
write_source "$src" 'name: prd
description: Duplicate of a pack skill.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: a name already in skills/ is refused" "skills/prd already exists in the pack" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: refused duplicate leaves the pack tree unchanged" "$root" "$before"

hq="$(make_hq)"
src="$hq/personal/skills/hq-login"
write_source "$src" 'name: hq-login
description: Copy of a core-resident skill.'
root="$(make_fixture)"; before="$(tree_sum "$root")"
expect_fail "import-skill: a core-resident name is refused" "hq-login is a core-resident skill" bash "$IMPORT" --root "$root" "$src"
expect_unchanged "import-skill: refused resident name leaves the pack tree unchanged" "$root" "$before"

hq="$(make_hq)"
src="$hq/personal/skills/listed"
write_source "$src" 'name: listed
description: Listed without a directory.'
root="$(make_fixture)"
insert_after "$root/package.yaml" "    - finish-estimate" "    - listed"
expect_fail "import-skill: a name already in contributes.skills is refused" "already lists listed" bash "$IMPORT" --root "$root" "$src"

hq="$(make_hq)"
src="$hq/personal/skills/foo"
write_source "$src" 'name: bar
description: Name differs from the directory.'
root="$(make_fixture)"
expect_fail "import-skill: frontmatter name different from the directory is refused" "must be equal" bash "$IMPORT" --root "$root" "$src"

hq="$(make_hq)"
src="$hq/personal/skills/secret-thing"
write_source "$src" 'name: secret-thing
description: Builder only.
private: true'
root="$(make_fixture)"
expect_fail "import-skill: private: true is refused" "private: true" bash "$IMPORT" --root "$root" "$src"

hq="$(make_hq)"
src="$hq/personal/skills/linky"
write_source "$src" 'name: linky
description: Has a symlink.'
ln -s /etc/hosts "$src/hosts"
root="$(make_fixture)"
expect_fail "import-skill: a source with a symlink is refused" "contains a symlink" bash "$IMPORT" --root "$root" "$src"

root="$(make_fixture)"
capture bash "$IMPORT" --root "$root"
if [[ "$RC" -eq 2 ]]; then ok "import-skill: no skill dir is bad usage (exit 2)"; else not_ok "import-skill: no skill dir is bad usage (exit 2)" "exit $RC: $OUT"; fi

# --- CONTRIBUTING.md -------------------------------------------------------------

contrib="$REPO/CONTRIBUTING.md"
contrib_missing=""
strip_keys="$(sed -n 's/^STRIP_KEYS="\(.*\)"$/\1/p' "$IMPORT")"
[[ -n "$strip_keys" ]] || contrib_missing+="(STRIP_KEYS not found in import-skill.sh)"$'\n'
for key in $strip_keys; do
  grep -qF -- "| \`$key\` |" "$contrib" || contrib_missing+="stripped key $key"$'\n'
done
for needle in \
  'bash scripts/import-skill.sh' \
  '### 2. Open a pull request' \
  '`/hq-core-review`' \
  'core-pr-reviews' \
  '`package.json` `version`' \
  '`package.yaml` `version`' \
  'A person from the approver set cuts the annotated' \
  'until its company owner retires it through' \
  'the `hq skill` lifecycle'; do
  grep -qF -- "$needle" "$contrib" || contrib_missing+="$needle"$'\n'
done
grep -qF '(CONTRIBUTING.md)' "$REPO/README.md" || contrib_missing+="README link to CONTRIBUTING.md"$'\n'
if [[ -z "$contrib_missing" ]]; then
  ok "CONTRIBUTING.md: import, PR, review, approval, version bump, tag, stripped keys, source skill retirement"
else
  not_ok "CONTRIBUTING.md: import, PR, review, approval, version bump, tag, stripped keys, source skill retirement" "missing: $contrib_missing"
fi
