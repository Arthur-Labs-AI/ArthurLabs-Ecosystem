#!/usr/bin/env bash
# test-package-capabilities.sh — the setup package path uses adapter
# capability keys (node, not nodejs) and missing Node reaches pacman.
# Fixture PATH only; pacman itself is never executed here.
# Run: bash scripts/launcher/tests/test-package-capabilities.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "CAPABILITIES-FAIL: $1"; exit 1; }
. "$REPO/scripts/launcher/linux/distros/cachyos.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/tools"
printf '#!/bin/sh\nexit 0\n' > "$T/tools/git"
chmod +x "$T/tools/git"
# The setup capability list carries `node`, never the package name `nodejs`.
have_node=0
have_nodejs=0
for cap in "${SENTRY_CACHYOS_CAPABILITIES[@]}"; do
  [ "$cap" = "node" ] && have_node=1
  [ "$cap" = "nodejs" ] && have_nodejs=1
done
[ "$have_node" = "1" ] || fail "capability list lacks node"
[ "$have_nodejs" = "0" ] || fail "capability list carries package name nodejs"
# Missing node resolves to the nodejs package through the adapter
# (fixture PATH without node, so CI machines with node still prove it).
# NOTE: VAR= assignments preceding a function call persist in bash — save
# and restore PATH explicitly instead of relying on prefix scoping.
OLD_PATH="$PATH"
PATH="$T/tools"
got=$(sentry_cachyos_missing node)
PATH="$OLD_PATH"
[ "$got" = "nodejs" ] || fail "missing node did not resolve to nodejs: [$got]"
# ... and is included verbatim in the install command.
cmd=$(sentry_cachyos_install_cmd "$got")
[ "$cmd" = "sudo pacman -S --needed nodejs" ] || fail "install command: [$cmd]"
# Present tools resolve to nothing.
OLD_PATH="$PATH"
PATH="$T/tools"
got_git=$(sentry_cachyos_missing git)
PATH="$OLD_PATH"
[ -z "$got_git" ] || fail "present git reported missing"
echo CAPABILITIES-OK
