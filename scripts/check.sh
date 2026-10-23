#!/usr/bin/env bash
# check.sh — every check CI runs on a pull request, in one command.
#
#   manifest-sync  scripts/check-manifest-sync.mjs (package.json version and
#                  engines hq-core / hq-cli equal package.yaml version and
#                  requires.hqCore / requires.hqCli)
#   contributes    scripts/check-contributes.sh
#   frontmatter    scripts/check-frontmatter.sh (name = dir, no skill_uid,
#                  no core-resident skill)
#   company-bind   scripts/vendor/lint-skill-company-bind.sh skills
#   commands-json  scripts/vendor/skill-inventory.sh --check (the committed
#                  commands.json equals a fresh render)
#
# All checks run even when an earlier one fails; the exit code is 1 when any
# failed. Regenerate commands.json with:
#   bash scripts/vendor/skill-inventory.sh --json --out commands.json
#
# Usage: check.sh [pack-root]   (default: this script's repo)

set -uo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="${1:-$(cd "$SCRIPTS/.." && pwd -P)}"

failed=()
run() {
  local label="$1"; shift
  echo "== $label"
  if "$@"; then :; else failed+=("$label"); fi
}

run manifest-sync node "$SCRIPTS/check-manifest-sync.mjs" "$ROOT"
run contributes bash "$SCRIPTS/check-contributes.sh" "$ROOT"
run frontmatter bash "$SCRIPTS/check-frontmatter.sh" "$ROOT"
run company-bind bash "$SCRIPTS/vendor/lint-skill-company-bind.sh" "$ROOT/skills"
run commands-json bash "$SCRIPTS/vendor/skill-inventory.sh" --root "$ROOT" --check

if [[ "${#failed[@]}" -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "All checks passed"
