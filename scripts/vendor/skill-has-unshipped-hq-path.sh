#!/usr/bin/env bash
# Vendored from indigoai-us/hq-core-staging core/scripts/lib/skill-has-unshipped-hq-path.sh
# at 04e2312b4b878857e6df10dbef6ba64209d78d55, unchanged below this header.
# hq-core build-claude-plugin.sh and build-codex-pack.sh call it per skill and
# leave out every skill it matches. scripts/import-skill.sh runs it on an
# imported skill.
#
# Return success when a skill contains a path rooted in the HQ checkout that
# is unavailable in the standalone plugin or Codex pack.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: skill-has-unshipped-hq-path.sh <SKILL.md>" >&2
  exit 2
fi

skill_file=$1

# Match a root-relative core/ or .claude/ path. A slash, dot, or home/repo
# prefix immediately before the path means it belongs to a nested checkout,
# such as libs/core/, $HOME/.claude/, or <repo>/.claude/. Also recognize paths
# explicitly rooted at HQ_ROOT / the HQ root or checkout.
if grep -Eq '(^|[^[:alnum:]_./~$-])(core/|\.claude/)|\./(core/|\.claude/)|\$HQ_ROOT/(core/|\.claude/)|\$\{HQ_ROOT\}/(core/|\.claude/)|(HQ_ROOT|HQ root|HQ checkout)/(core/|\.claude/)' "$skill_file"; then
  exit 0
fi

exit 1
