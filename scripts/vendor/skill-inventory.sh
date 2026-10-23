#!/usr/bin/env bash
# Vendored from indigoai-us/hq-core-staging core/scripts/skill-inventory.sh
# at 04e2312b4b878857e6df10dbef6ba64209d78d55. Changes: usage lines point at
# this pack's paths, and the --markdown mode is not carried (see
# skill-inventory.mjs).
#
# skill-inventory.sh — read-only inventory of the pack's skills.
#
# Generates the command palette data (commands.json at the pack root) from
# skills/, and reports exact duplicates, drifted copies, and near-duplicate
# descriptions. Implementation: scripts/vendor/skill-inventory.mjs. Run with
# --help for modes.
#
# Usage:
#   bash scripts/vendor/skill-inventory.sh --root <pack> --findings
#   bash scripts/vendor/skill-inventory.sh --json --out commands.json
#   bash scripts/vendor/skill-inventory.sh --check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null 2>&1 || { echo "skill-inventory: node is required" >&2; exit 69; }
exec node "$SCRIPT_DIR/skill-inventory.mjs" "$@"
