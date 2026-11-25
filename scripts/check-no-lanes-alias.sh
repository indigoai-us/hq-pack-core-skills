#!/usr/bin/env bash
# check-no-lanes-alias.sh — fail when any file under skills/ or commands.json
# contains the deprecated literal `hq lanes` alias.
#
# Usage: check-no-lanes-alias.sh [pack-root]   (default: this script's repo)
# Exit 0 clean · 1 alias found · 2 bad usage.

set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
SKILLS_DIR="$ROOT/skills"
COMMANDS_JSON="$ROOT/commands.json"

[[ -d "$SKILLS_DIR" ]] || { echo "check-no-lanes-alias: no skills dir at $SKILLS_DIR" >&2; exit 2; }

targets=("skills")
if [[ -f "$COMMANDS_JSON" ]]; then
  targets+=("commands.json")
fi

matches="$(cd "$ROOT" && grep -rnFHa -- "hq lanes" "${targets[@]}" || true)"
if [[ -n "$matches" ]]; then
  echo "check-no-lanes-alias: deprecated 'hq lanes' alias found (use 'hq runners'):" >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

echo "OK: no literal 'hq lanes' found under skills/ or commands.json"
