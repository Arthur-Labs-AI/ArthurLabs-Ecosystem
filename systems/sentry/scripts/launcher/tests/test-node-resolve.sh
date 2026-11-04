#!/usr/bin/env bash
# test-node-resolve.sh — Node ensure decisions with fixture binaries.
# No system mutation, no sudo: PATH fixtures only.
# Run: bash scripts/launcher/tests/test-node-resolve.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "NODERESOLVE-FAIL: $1"; exit 1; }
. "$REPO/scripts/launcher/linux/lib/common.sh"
. "$REPO/scripts/launcher/linux/lib/node.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/oldbin" "$T/emptybin" "$T/newbin"
printf '#!/bin/sh\necho v20.9.9\n' > "$T/oldbin/node"
chmod +x "$T/oldbin/node"
printf '#!/bin/sh\necho v22.9.9\n' > "$T/newbin/node"
chmod +x "$T/newbin/node"
# Old node fails closed with remediation (never silently accepted).
out=$(PATH="$T/oldbin" SENTRY_NODE_BINARY="" sentry_ensure_node 2>&1 || true)
case "$out" in
  *"too old"*"sudo pacman -S --needed nodejs npm"*) ;;
  *) fail "old node not rejected with remediation: [$out]" ;;
esac
if PATH="$T/oldbin" SENTRY_NODE_BINARY="" sentry_ensure_node >/dev/null 2>&1; then
  fail "old node exited 0"
fi
# Missing node fails closed.
out=$(PATH="$T/emptybin" SENTRY_NODE_BINARY="" sentry_ensure_node 2>&1 || true)
case "$out" in
  *"No standalone Node.js executable found"*) ;;
  *) fail "missing node not rejected: [$out]" ;;
esac
# A modern node on PATH resolves to an absolute path (fixture binary). 
out=$(PATH="$T/newbin:$PATH" SENTRY_NODE_BINARY="" sentry_ensure_node 2>&1) || fail "fixture node rejected"
case "$out" in
  *"SENTRY_NODE_RESOLVED="*) ;;
  *) fail "no resolved line: [$out]" ;;
esac
resolved=$(printf '%s\n' "$out" | sed -n 's/^SENTRY_NODE_RESOLVED=//p' | head -n 1)
case "$resolved" in
  "$T/newbin/node") ;;
  *) fail "not the fixture absolute path: [$resolved]" ;;
esac
case "$out" in
  *"v22.9.9"*) ;;
  *) fail "version not reported: [$out]" ;;
esac
# An absolute override of a real modern node is kept verbatim.
realnode=$(command -v node)
out=$(SENTRY_NODE_BINARY="$realnode" sentry_ensure_node 2>&1) || fail "absolute override rejected"
case "$out" in
  *"SENTRY_NODE_RESOLVED=$realnode"*) ;;
  *) fail "override not kept: [$out]" ;;
esac
echo NODERESOLVE-OK
