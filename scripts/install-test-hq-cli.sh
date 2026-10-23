#!/usr/bin/env bash
# install-test-hq-cli.sh — install the oldest hq-cli this pack supports, for
# the tests that drive hq-cli's real install code (tests/tamper-install.test.mjs
# and tests/hq-cli-compat.test.mjs).
#
# The version is package.json engines["hq-cli"] with its ">=" removed, so the
# tests run against the minimum CLI the pack declares. Lifecycle scripts are
# skipped (`--ignore-scripts`): the tests import hq-cli's dist modules only.
#
# Usage: install-test-hq-cli.sh PREFIX
# Prints `HQ_CLI_DIR=<PREFIX>/node_modules/@indigoai-us/hq-cli` on stdout, the
# line a workflow appends to $GITHUB_ENV. Locally, export the same variable or
# point it at an hq-cli checkout that has been built (`dist/` present).

set -euo pipefail

PREFIX="${1:?usage: install-test-hq-cli.sh PREFIX}"
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPTS/.." && pwd -P)"

range="$(node -e 'process.stdout.write(String((require(process.argv[1]).engines || {})["hq-cli"] || ""))' "$ROOT/package.json")"
if [[ ! "$range" =~ ^\>=([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "install-test-hq-cli: package.json engines[\"hq-cli\"] is \"$range\"; expected >=X.Y.Z" >&2
  exit 1
fi
version="${BASH_REMATCH[1]}"

mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" --no-save --ignore-scripts --no-audit --no-fund --loglevel=error \
  "@indigoai-us/hq-cli@$version" >&2

dir="$PREFIX/node_modules/@indigoai-us/hq-cli"
[[ -f "$dir/dist/commands/pack-install.js" ]] || { echo "install-test-hq-cli: $dir has no dist/commands/pack-install.js" >&2; exit 1; }
echo "install-test-hq-cli: hq-cli $version at $dir" >&2
printf 'HQ_CLI_DIR=%s\n' "$dir"
