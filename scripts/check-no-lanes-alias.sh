#!/usr/bin/env bash
# check-no-lanes-alias.sh — fail when any file under skills/ or commands.json
# contains the deprecated literal `hq lanes` alias.
#
# Usage: check-no-lanes-alias.sh [pack-root]   (default: this script's repo)
# Exit 0 clean · 1 alias found · 2 bad usage or a file could not be read.

set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
SKILLS_DIR="$ROOT/skills"
COMMANDS_JSON="$ROOT/commands.json"

[[ -d "$SKILLS_DIR" ]] || { echo "check-no-lanes-alias: no skills dir at $SKILLS_DIR" >&2; exit 2; }

targets=("skills")
if [[ -f "$COMMANDS_JSON" ]]; then
  targets+=("commands.json")
fi

cd "$ROOT" || { echo "check-no-lanes-alias: cannot enter $ROOT" >&2; exit 2; }

# grep exits 0 on a match, 1 on no match, and 2 or more when it could not read
# something. Only exit 1 means the tree is clean.
grep_rc=0
matches="$(grep -rnFHa -- "hq lanes" "${targets[@]}")" || grep_rc=$?
if [[ "$grep_rc" -gt 1 ]]; then
  echo "check-no-lanes-alias: grep could not read every file (exit $grep_rc)" >&2
  exit 2
fi
if [[ -n "$matches" ]]; then
  echo "check-no-lanes-alias: deprecated 'hq lanes' alias found (use 'hq runners'):" >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

echo "OK: no literal 'hq lanes' found under skills/ or commands.json"
